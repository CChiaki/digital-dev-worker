<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { goBackOrHome } from '../router-utils.js';
import { ArrowLeft } from '@element-plus/icons-vue';
import { api, type EmployeeRecordView, type TaskSummary } from '../api.js';
import { zh, SUPERVISION_ZH, TASK_STATUS_ZH, TASK_STATUS_TAG } from '../status.js';
import EmployeeEditDialog from '../components/EmployeeEditDialog.vue';

// 员工详情（2026-09-06）：上半档案卡（复用 EmployeeEditDialog 编辑）+ 下当前/历史任务双 tab 下钻
const props = defineProps<{ employeeId: string }>();
const router = useRouter();

const employee = ref<EmployeeRecordView | null>(null);
const currentTasks = ref<TaskSummary[]>([]);
const historyTasks = ref<TaskSummary[]>([]);
const tab = ref<'current' | 'history'>('current');
const error = ref('');
const dialogVisible = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  error.value = '';
  try {
    // GET /api/employees 全量后按 id 过滤（列表接口自带忙闲/能力绑定/脱敏 model）
    const emps = await api.listEmployees();
    employee.value = emps.find((e) => e.id === props.employeeId) ?? null;
    const [cur, hist] = await Promise.all([
      api.listTasksFiltered({ claimedBy: props.employeeId, status: 'claimed,running' }),
      api.listTasksFiltered({ claimedBy: props.employeeId, status: 'done,failed' }),
    ]);
    currentTasks.value = cur;
    historyTasks.value = hist;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

watch(() => props.employeeId, load);
onMounted(() => {
  void load();
  timer = setInterval(load, 5000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const rows = computed(() => (tab.value === 'current' ? currentTasks.value : historyTasks.value));

/** 计划进度摘要：done/total，停点项计数追加提示 */
function planSummary(t: TaskSummary): string {
  const pp = t.planProgress ?? [];
  if (!pp.length) return '—';
  const done = pp.filter((i) => i.status === 'done').length;
  const failed = pp.filter((i) => i.status === 'failed').length;
  return failed ? `${done}/${pp.length} 项 · ${failed} 项停点` : `${done}/${pp.length} 项`;
}

/** 汇报摘要截断（result.reply），无结果占位 */
function replySummary(t: TaskSummary): string {
  const s = (t.reply ?? '').trim();
  return s ? (s.length > 60 ? `${s.slice(0, 60)}…` : s) : '—';
}

function openTask(taskId: string) {
  void router.push(`/tasks/${taskId}`);
}

/** 执行中任务进入员工直播（旧「员工直播」入口承接） */
function openLive() {
  void router.push(`/employees/${props.employeeId}/live`);
}

</script>

<template>
  <section class="view">
    <div class="flex items-center gap-3 mb-4">
      <el-button data-test="back-btn" :icon="ArrowLeft" text @click="goBackOrHome(router)">返回</el-button>
      <h2 class="!mb-0">员工详情 · {{ employeeId }}</h2>
    </div>

    <el-alert v-if="error" data-test="error" :title="error" type="error" :closable="false" show-icon class="mb-4" />

    <!-- 档案卡 -->
    <el-card shadow="never" data-test="profile-card">
      <template #header>
        <div class="flex items-center justify-between">
          <strong>员工档案</strong>
          <el-button data-test="edit-btn" type="primary" :disabled="!employee" @click="dialogVisible = true">编辑</el-button>
        </div>
      </template>
      <el-descriptions v-if="employee" :column="3" border>
        <el-descriptions-item label="ID"><code>{{ employee.id }}</code></el-descriptions-item>
        <el-descriptions-item label="姓名">{{ employee.name }}</el-descriptions-item>
        <el-descriptions-item label="岗位">
          <!-- 多岗位 tags（2026-09-07） -->
          <el-tag v-for="r in employee.roles ?? []" :key="r" class="mr-1.5">{{ r }}</el-tag>
          <span v-if="!(employee.roles ?? []).length" class="text-gray-400">—</span>
        </el-descriptions-item>
        <el-descriptions-item label="盯梢等级">{{ zh(SUPERVISION_ZH, employee.supervision) }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="employee.enabled ? 'success' : 'info'" class="mr-1.5">{{ employee.enabled ? '启用' : '已停用' }}</el-tag>
          <el-tag data-test="busy" :type="employee.busy ? 'primary' : 'info'" class="mr-1.5">
            {{ employee.busy ? '执行中' : '空闲' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="专属模型">
          <template v-if="employee.model">
            <code>{{ employee.model.model }}</code>
            <span class="text-gray-400"> · {{ employee.model.api === 'anthropic-messages' ? 'Anthropic 兼容' : 'OpenAI 兼容' }} · {{ employee.model.baseUrl }}</span>
          </template>
          <span v-else class="text-gray-400">全局模型</span>
        </el-descriptions-item>
        <el-descriptions-item label="能力绑定" :span="3">
          <el-tag v-for="c in employee.capabilities ?? []" :key="c" type="warning" class="mr-1.5">{{ c }}</el-tag>
          <span v-if="!(employee.capabilities ?? []).length" class="text-gray-400">全部能力</span>
        </el-descriptions-item>
      </el-descriptions>
      <el-empty v-else description="员工不存在或已删除" />
    </el-card>

    <EmployeeEditDialog v-model="dialogVisible" :employee="employee" @saved="load" />

    <!-- 任务下钻：双 tab 双数据源（claimed,running / done,failed） -->
    <el-card shadow="never" class="mt-4">
      <el-tabs v-model="tab">
        <el-tab-pane label="当前任务" name="current" data-test="tab-current" />
        <el-tab-pane label="历史任务" name="history" data-test="tab-history" />
      </el-tabs>

      <el-empty v-if="rows.length === 0" :description="tab === 'current' ? '暂无进行中的任务' : '暂无历史任务'" />
      <el-table v-else :data="rows" data-test="task-table" @row-click="(row: TaskSummary) => openTask(row.taskId)">
        <el-table-column prop="taskId" label="任务 ID" width="190">
          <template #default="scope"><code>{{ scope.row.taskId }}</code></template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="160" show-overflow-tooltip />
        <el-table-column label="状态" width="90">
          <template #default="scope">
            <el-tag data-test="status-tag" :type="TASK_STATUS_TAG[scope.row.status] ?? 'info'">
              {{ zh(TASK_STATUS_ZH, scope.row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="计划进度" width="150">
          <template #default="scope">{{ planSummary(scope.row) }}</template>
        </el-table-column>
        <el-table-column label="汇报摘要" min-width="200">
          <template #default="scope">
            <span class="text-gray-400">{{ replySummary(scope.row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110">
          <template #default="scope">
            <el-button
              v-if="scope.row.status === 'claimed' || scope.row.status === 'running'"
              data-test="live-btn"
              link
              type="primary"
              @click.stop="openLive"
            >进入直播</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </section>
</template>

<style scoped>
/* EP 表格行内部结构：Tailwind 无法直达，保留 :deep 覆写 */
:deep(.el-table__row) { cursor: pointer; }
</style>
