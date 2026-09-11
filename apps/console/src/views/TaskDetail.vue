<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { goBackOrHome } from '../router-utils.js';
import { ArrowLeft } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type TaskAudit, type TaskDetailRecord } from '../api.js';
import { employeeName, ensureEmployeeNames } from '../employee-names.js';
import type { AgentEvent } from '@ddw/runtime';
import { zh, TASK_STATUS_ZH, TASK_STATUS_TAG, EVENT_TYPE_ZH, SUPERVISION_ZH } from '../status.js';
import PlanProgress from '../components/PlanProgress.vue';
import TaskCreateDialog from '../components/TaskCreateDialog.vue';

const props = defineProps<{ taskId: string }>();
const router = useRouter();

const record = ref<TaskDetailRecord | null>(null);
const checks = ref<AgentEvent[]>([]);        // task_check 申报事件
const interventions = ref<AgentEvent[]>([]); // intervention 复核事件（放行/驳回）
const audit = ref<TaskAudit | null>(null);
const error = ref('');
const resuming = ref(false);
// 失败任务编辑（2026-09-10 用户需求）：配置不合理时改任务包重发（upsert 复位 draft）
const editVisible = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  error.value = '';
  try {
    void ensureEmployeeNames(); // 姓名映射并行拉取（失败静默回退显示 id，不阻塞详情）
    record.value = await api.getTask(props.taskId);
    await loadSidecars();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/** 附属数据：节点申报/复核事件 + 审计聚合（聚合失败不阻塞详情） */
async function loadSidecars() {
  const [taskCheckEvents, interventionEvents, auditResult] = await Promise.all([
    api.listEvents({ taskId: props.taskId, type: 'task_check' }),
    api.listEvents({ taskId: props.taskId, type: 'intervention' }),
    api.auditTask(props.taskId).catch(() => null),
  ]);
  checks.value = Array.isArray(taskCheckEvents) ? taskCheckEvents : [];
  interventions.value = Array.isArray(interventionEvents) ? interventionEvents : [];
  audit.value = auditResult;
}

/** 计划续跑（2026-09-05）：仅 failed 任务且有停点项时可用；成功后 status 回 pending。
 *  分派统一自动（2026-09-06 用户确认）：详情页去掉人工接单按钮，续跑由调度器点名原执行员工 */
async function resume() {
  resuming.value = true;
  error.value = '';
  try {
    const res = await api.resumeTask(props.taskId);
    ElMessage.success(`任务 ${props.taskId} 已复位为 ${res.status === 'pending' ? '待分派' : res.status}，将从失败项重新调度`);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e); // 409 message 原样展示
  } finally {
    resuming.value = false;
  }
}

/** 强制重置（2026-09-11 P0 韧性批）：claimed/running 卡死（模型 hang / 进程中断残留）时
 *  管理员出路——后端先中性化在途执行（迟到回写守卫）再清执行态回 pending，可重新执行 */
async function forceReset() {
  try {
    await ElMessageBox.confirm(
      `确认强制重置任务 ${props.taskId}？执行中员工的回写将被丢弃，任务回到待分派（执行态清空，进度不保留——需保留进度请用失败后的「续跑」）。`,
      '强制重置',
      { type: 'warning', confirmButtonText: '强制重置', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    const res = await api.forceResetTask(props.taskId);
    ElMessage.success(`任务 ${props.taskId} 已重置为待分派（${res.status}）`);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

watch(() => props.taskId, load);
onMounted(() => {
  void load();
  timer = setInterval(load, 5000); // 实时感：对齐名册/放行页轮询惯例
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

/** 某任务项的节点申报（task_check 事件 payload.item 对应项 id） */
function checksOf(itemId: string): AgentEvent[] {
  return checks.value.filter((x) => (x.payload as { item?: string } | undefined)?.item === itemId);
}

/** token 数值显示（2026-09-11 P2 产品批）：千分位，成本可见性 */
function fmtTokens(n: number): string {
  return n.toLocaleString();
}

/**
 * 节点验收四态（P12-T2）：task_check 申报与 intervention 复核按时间归组，取最新状态。
 * 待申报：无申报；待放行：最新申报 awaiting 且其后无复核；
 * 已放行/已驳回：最近一次复核结果（驳回行内显示意见——员工正在修正）。
 */
type CheckState = 'unchecked' | 'awaiting' | 'approved' | 'rejected';

function stateOf(itemId: string): { state: CheckState; result?: string; comment?: string } {
  const declares = checksOf(itemId);
  if (declares.length === 0) return { state: 'unchecked' };
  const last = declares[declares.length - 1]!;
  const result = (last.payload as { result?: string } | undefined)?.result;
  const after = interventions.value.filter((x) => (x.payload as { item?: string } | undefined)?.item === itemId && x.ts >= last.ts);
  const lastReview = after[after.length - 1];
  if (!lastReview) {
    return (last.payload as { awaiting?: boolean } | undefined)?.awaiting === true
      ? { state: 'awaiting', result }
      : { state: 'approved', result };
  }
  const approved = (lastReview.payload as { approved?: boolean } | undefined)?.approved === true;
  const comment = (lastReview.payload as { comment?: string } | undefined)?.comment;
  return approved ? { state: 'approved', result } : { state: 'rejected', result, ...(comment ? { comment } : {}) };
}

const STATE_LABEL: Record<CheckState, string> = {
  unchecked: '待申报',
  awaiting: '待放行',
  approved: '已放行',
  rejected: '已驳回',
};

/** 执行中项（2026-09-06 用户反馈）：任务 running 时第一个待执行项——纯展示态，
 *  续跑复位后失败项回「待执行」，分派执行中即时可见「执行中」而非残留「失败」 */
const activeItemId = computed(() =>
  record.value?.status === 'running'
    ? record.value.planProgress?.find((p) => p.status === 'skipped')?.itemId
    : undefined,
);

const CHECK_TAG: Record<CheckState, 'info' | 'warning' | 'success' | 'danger'> = {
  unchecked: 'info',
  awaiting: 'warning',
  approved: 'success',
  rejected: 'danger',
};
</script>

<template>
  <section class="view">
    <div class="flex items-center gap-3 mb-4">
      <el-button data-test="back-btn" :icon="ArrowLeft" text @click="goBackOrHome(router)">返回</el-button>
      <h2 class="!mb-0">任务详情 · {{ props.taskId }}</h2>
      <!-- 卡死态快捷操作（2026-09-11 用户反馈）：强制重置提到标题行最右——不用滚到页尾找出口；
           claimed/running 才有意义（语义同下方说明），danger 红钮贴右侧显眼 -->
      <el-button
        v-if="record && (record.status === 'claimed' || record.status === 'running')"
        data-test="force-reset-btn"
        type="danger"
        class="ml-auto"
        @click="forceReset"
      >强制重置</el-button>
    </div>
    <el-alert v-if="error" data-test="error" :title="error" type="error" :closable="false" show-icon />
    <p v-else-if="!record" class="text-gray-400">加载中…</p>

    <template v-else>
      <el-card shadow="never" class="mb-4">
        <template #header>
          <div class="flex items-center gap-2.5">
            <strong>{{ record.pkg.title }}</strong>
            <el-tag data-test="badge" :type="TASK_STATUS_TAG[record.status] ?? 'info'">{{ zh(TASK_STATUS_ZH, record.status) }}</el-tag>
          </div>
        </template>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="仓库">{{ record.pkg.repo.url }}</el-descriptions-item>
          <el-descriptions-item label="工作分支">{{ record.pkg.repo.branch }}</el-descriptions-item>
          <el-descriptions-item label="基线分支">{{ record.pkg.repo.baseBranch ?? '-' }}</el-descriptions-item>
          <el-descriptions-item v-if="record.pkg.assignee" label="指定员工" data-test="assignee">
            {{ employeeName(record.pkg.assignee) }}
          </el-descriptions-item>
          <!-- 包级依赖（2026-09-06 用户反馈）：全部依赖任务 done 后本任务才可被分派；
               data-test 放内容元素——descriptions-item 不透传 attrs 到 DOM -->
          <el-descriptions-item v-if="record.pkg.dependsOn?.length" label="包级依赖">
            <span data-test="depends-on">
              <el-tag v-for="d in record.pkg.dependsOn" :key="d" class="font-mono mr-1.5">{{ d }}</el-tag>
              <span class="text-gray-400 text-[12px]">全部完成后才可分派</span>
            </span>
          </el-descriptions-item>
          <el-descriptions-item v-if="record.claimedBy" label="领取人">{{ employeeName(record.claimedBy) }}</el-descriptions-item>
          <el-descriptions-item v-if="record.result" label="执行结果" :span="2">
            {{ record.result.status }}（{{ record.result.turns }} 轮）：{{ record.result.reply }}
          </el-descriptions-item>
          <!-- token 用量（2026-09-11 P2 产品批）：任务全程模型调用累计，成本可见性 -->
          <el-descriptions-item v-if="record.result?.tokenUsage" label="Token 用量" :span="2">
            <span data-test="token-usage" class="font-mono">
              输入 {{ fmtTokens(record.result.tokenUsage.input) }} / 输出 {{ fmtTokens(record.result.tokenUsage.output) }}
              （{{ record.result.tokenUsage.calls }} 次模型调用）
            </span>
          </el-descriptions-item>
        </el-descriptions>

        <!-- 计划明细（2026-09-06 用户反馈设计缺陷修复）：pkg.plan 存在即渲染（draft 也能看每步详情），
             执行后与下方进度时间线共存——明细 = 任务定义，进度 = 执行态 -->
        <div v-if="record.pkg.plan?.length" data-test="plan-detail" class="mt-5">
          <p class="text-gray-400 mb-2">计划明细（{{ record.pkg.plan.length }} 步）：</p>
          <el-table :data="record.pkg.plan" size="default" border>
            <el-table-column type="index" label="#" width="48" align="center" />
            <el-table-column label="步骤" min-width="180">
              <template #default="{ row }">
                <span class="font-medium">{{ row.title }}</span>
              </template>
            </el-table-column>
            <el-table-column label="类型" width="92" align="center">
              <template #default="{ row }">
                <el-tag class="font-mono">{{ row.kind ?? 'dev' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="任务要求" min-width="260">
              <template #default="{ row }">
                <span class="whitespace-pre-wrap">{{ row.detail }}</span>
              </template>
            </el-table-column>
            <el-table-column label="验收命令" min-width="200">
              <template #default="{ row }">
                <span v-if="row.verify" class="font-mono text-[12px]">{{ row.verify }}</span>
                <span v-else class="text-gray-400">无（员工申报即通过）</span>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 计划进度（2026-09-05）：逐项留痕 + 失败停点高亮；任务执行中时第一个待执行项显示「执行中」；
             悬浮节点展示任务包 yml 明细（要求/验收命令，2026-09-06 用户反馈） -->
        <PlanProgress
          :progress="record.planProgress"
          :failed-item-id="record.failedItemId"
          :active-item-id="activeItemId"
          :plan-items="record.pkg.plan"
        />

        <!-- 失败态操作（2026-09-10）：续跑（保留进度）或编辑任务包（改配置重发，upsert 复位 draft） -->
        <div v-if="record.status === 'failed'" class="flex gap-2">
          <el-button v-if="record.failedItemId" data-test="resume-btn" type="warning" :loading="resuming" @click="resume">
            {{ resuming ? '续跑中…' : '从失败项续跑' }}
          </el-button>
          <el-button data-test="edit-task-btn" @click="editVisible = true">编辑任务</el-button>
        </div>
        <!-- 卡死态出口已提到标题行右侧（2026-09-11 用户反馈）——claimed/running 不能续跑不能重提，
             强制重置是唯一出路；此处保留一句就地提示 -->
        <el-alert
          v-if="record.status === 'claimed' || record.status === 'running'"
          title="任务执行中。卡死（模型无响应/进程残留）时可用右上角「强制重置」回到待分派。"
          type="info"
          :closable="false"
          class="mb-3"
          data-test="stuck-hint"
        />
        <TaskCreateDialog v-model="editVisible" :edit-task-id="props.taskId" @created="load" />
      </el-card>

      <el-card v-for="t in record.pkg.tasks" :key="t.id" shadow="never" class="mb-4">
        <template #header><strong>{{ t.id }} · {{ t.title }}</strong></template>
        <p>要求：{{ t.requirement }}</p>
        <p class="text-gray-400 mb-1">涉及文件：</p>
        <p><el-tag v-for="f in t.files" :key="f" class="font-mono">{{ f }}</el-tag></p>
        <p class="text-gray-400 mb-1">验收标准：</p>
        <ul class="m-0 mb-2 pl-[18px]">
          <li v-for="a in t.acceptance" :key="a" class="my-0.5">{{ a }}</li>
        </ul>
        <p class="text-gray-400 mb-1">节点验收（数字员工申报 → shadow 级人工放行）：</p>
        <ul data-test="check-list" class="m-0 mb-2 pl-[18px]">
          <li
            v-for="c in [stateOf(t.id)]"
            :key="c.state + t.id"
            :data-test="`check-item-${t.id}`"
            class="my-0.5 flex gap-2 items-center flex-wrap"
          >
            <el-tag data-test="check-state" :type="CHECK_TAG[c.state]">{{ STATE_LABEL[c.state] }}</el-tag>
            <span v-if="c.result">{{ c.result }}</span>
            <el-alert
              v-if="c.state === 'rejected' && c.comment"
              data-test="reject-comment"
              :title="`驳回意见：${c.comment}`"
              type="error"
              :closable="false"
              class="mt-1.5 px-2 py-1"
            />
          </li>
        </ul>
      </el-card>

      <el-card v-if="audit" shadow="never" class="mb-4">
        <template #header><strong>执行档案</strong></template>
        <p class="text-gray-400 mb-1">工具调用统计：</p>
        <ul data-test="tool-calls" class="m-0 mb-2 pl-[18px]">
          <li v-for="tc in audit.toolCalls" :key="tc.name" class="my-0.5">
            <el-tag class="font-mono">{{ tc.name }}</el-tag> × {{ tc.count }}
            <span v-if="tc.errors > 0" class="text-danger">（{{ tc.errors }} 次错误）</span>
          </li>
          <li v-if="audit.toolCalls.length === 0" class="text-gray-400">暂无工具调用</li>
        </ul>
        <p v-if="audit.reply" class="text-gray-400">最终汇报：{{ audit.reply }}</p>
      </el-card>
    </template>
  </section>
</template>
