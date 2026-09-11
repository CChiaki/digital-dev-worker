<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type EmployeeRecordView, type PlanProgress, type TaskSummary } from '../api.js';
import { onAgentEvent } from '../live.js';
import { employeeName, ensureEmployeeNames } from '../employee-names.js';
import TaskCreateDialog from '../components/TaskCreateDialog.vue';
import { zh, TASK_STATUS_ZH, TASK_STATUS_TAG, depsLabel } from '../status.js';

const router = useRouter();

// 实时化（2026-09-11 P2 产品批）：agent 事件触发即时刷新（事件到来 = 某任务状态在变），
// 5s 轻轮询兜底（SSE 不通时仍自动刷新）；事件风暴下防抖 500ms 合并重载
const REFRESH_DEBOUNCE_MS = 500;
const POLL_MS = 5_000;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshQueued = false;

function queueRefresh(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  refreshTimer = setTimeout(() => {
    refreshQueued = false;
    void load(true); // 事件触发同样走 quiet：不打断用户操作
  }, REFRESH_DEBOUNCE_MS);
}
const agentSub = onAgentEvent(() => queueRefresh());

const tasks = ref<TaskSummary[]>([]);
const loading = ref(false);
const error = ref('');
const createVisible = ref(false); // 创建入口（2026-09-05）：双模式对话框（表单配置 / yaml 直贴）

/** 编辑草稿（2026-09-06 用户需求）：非空 = 编辑模式传入对话框（yaml 回填，保存走 draft 覆盖）；关闭时复位 */
const editingTaskId = ref('');
watch(createVisible, (v) => {
  if (!v) editingTaskId.value = '';
});
function openEdit(row: TaskSummary) {
  editingTaskId.value = row.taskId;
  createVisible.value = true;
}

/** 检索区（2026-09-06 表格化改造）：关键词 + 状态多选（空 = 全部） */
const keyword = ref('');
const statusFilter = ref<string[]>([]);
const STATUS_OPTIONS = Object.entries(TASK_STATUS_ZH).map(([value, label]) => ({ value, label }));

/** 检索过滤（spec §4）：关键词匹配 taskId/标题（大小写不敏感，与 SkillLibrary/Employees 等页口径统一，2026-09-08）；状态多选空=全部 */
function matches(t: TaskSummary, kw: string, statuses: string[]): boolean {
  const k = kw.trim().toLowerCase();
  const kwOk = !k || t.taskId.toLowerCase().includes(k) || t.title.toLowerCase().includes(k);
  const stOk = statuses.length === 0 || statuses.includes(t.status);
  return kwOk && stOk;
}
const visibleTasks = computed(() => tasks.value.filter((t) => matches(t, keyword.value, statusFilter.value)));
defineExpose({ matches });

async function load(quiet = false) {
  // quiet（轮询/事件触发）：不翻 loading 遮罩——表格每 5s 闪一次加载态会打断操作
  if (!quiet) loading.value = true;
  error.value = '';
  try {
    void ensureEmployeeNames(); // 姓名映射并行拉取（失败静默回退显示 id，不阻塞列表）
    tasks.value = await api.listTasks();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (!quiet) loading.value = false;
  }
}

/** 进入任务详情（路由化 Task 7）：行点击 / 操作列「详情」直达 */
function openTask(taskId: string) {
  void router.push(`/tasks/${taskId}`);
}
/** el-table 行点击适配（row-click 回调带 row 参数） */
function openRow(row: TaskSummary) {
  openTask(row.taskId);
}

/** 发布确认弹窗（2026-09-06 用户要求）：点「发布」先弹窗确认选员工，不选 = 默认自动接单。
 *  选中 → 先 assign 写 pkg.assignee（调度器 acquireById 点名生效）再 publish；留空 → 直接 publish */
const publishVisible = ref(false);
const publishTaskId = ref('');
const publishAssignee = ref('');
const publishEmployeeOptions = ref<EmployeeRecordView[]>([]);
const publishing = ref(false);

async function openPublish(row: TaskSummary) {
  publishTaskId.value = row.taskId;
  publishAssignee.value = row.assignee ?? ''; // 已指定过则预填（发布失败重试场景）
  publishVisible.value = true;
  try {
    publishEmployeeOptions.value = (await api.listEmployees()).filter((e) => e.enabled); // 停用员工不进选项
  } catch {
    publishEmployeeOptions.value = []; // 员工接口不可用不阻塞发布：空列表可留空走自动接单
    ElMessage.error('员工列表获取失败，可留空直接发布（自动接单）');
  }
}

async function confirmPublish() {
  const taskId = publishTaskId.value;
  publishing.value = true;
  error.value = '';
  try {
    if (publishAssignee.value) {
      await api.assignTask(taskId, publishAssignee.value); // 点名写入 pkg.assignee
    }
    await api.publishTask(taskId);
    ElMessage.success(publishAssignee.value ? `已发布，将分派给 ${employeeName(publishAssignee.value)}` : '已发布，任务进入自动接单');
    publishVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e)); // 400/409 弹窗层可见，不被遮罩挡
  } finally {
    publishing.value = false;
  }
}

/** 计划进度列文案：done 项数/总项数；无计划返回空（模板内联箭头不支持类型标注，故收进 script） */
function planProgressLabel(progress: PlanProgress[] | undefined): string {
  if (!progress?.length) return '';
  return `${progress.filter((p) => p.status === 'done').length}/${progress.length} 项`;
}

/** 强制重置（2026-09-11 P0 韧性批）：claimed/running 卡死（模型 hang / 进程中断残留）时
 *  管理员出路——后端先中性化在途执行（迟到回写守卫）再清执行态回 pending，可重新发布执行 */
async function forceReset(row: TaskSummary) {
  try {
    await ElMessageBox.confirm(
      `确认强制重置任务 ${row.taskId}（${row.title}）？执行中员工的回写将被丢弃，任务回到待分派（执行态清空，进度不保留——需保留进度请用失败后的「编辑」重跑）。`,
      '强制重置',
      { type: 'warning', confirmButtonText: '强制重置', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await api.forceResetTask(row.taskId);
    ElMessage.success(`任务 ${row.taskId} 已重置为待分派`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(() => {
  void load();
  pollTimer = setInterval(() => void load(true), POLL_MS);
});
onUnmounted(() => {
  agentSub.off();
  if (pollTimer) clearInterval(pollTimer);
  if (refreshTimer) clearTimeout(refreshTimer);
});
</script>

<template>
  <section class="view">
    <h2>任务中心</h2>

    <div class="flex items-center gap-3 mb-4">
      <el-input
        data-test="search-input"
        v-model="keyword"
        placeholder="搜索任务 ID / 标题"
        clearable
        class="!w-64"
      />
      <el-select
        data-test="status-filter"
        v-model="statusFilter"
        multiple
        collapse-tags
        placeholder="状态（全部）"
        clearable
        :teleported="false"
        class="!w-56"
      >
        <el-option v-for="o in STATUS_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-button v-if="keyword || statusFilter.length" data-test="clear-filter" link @click="keyword = ''; statusFilter = []">清筛选</el-button>
      <el-alert v-if="error" data-test="error" :title="error" type="error" :closable="false" show-icon class="flex-1" />
      <el-button data-test="dag-btn" class="ml-auto" @click="router.push('/tasks/dag')">编排视图</el-button>
      <el-button data-test="create-btn" type="primary" @click="createVisible = true">新建任务</el-button>
    </div>

    <!-- 编排视图（2026-09-08 用户反馈：弹窗效果差改独立页）：/tasks/dag 全宽 DAG，见 TaskDagView.vue -->

    <TaskCreateDialog v-model="createVisible" :edit-task-id="editingTaskId || undefined" @created="() => load()" />

    <!-- 发布确认弹窗（2026-09-06）：小窗确认选员工，不选 = 默认自动接单 -->
    <el-dialog v-model="publishVisible" :title="`发布任务 · ${publishTaskId}`" width="420px">
      <el-select
        data-test="publish-assignee-select"
        v-model="publishAssignee"
        clearable
        filterable
        placeholder="选择数字员工（不选 = 自动接单）"
        :teleported="false"
        class="!w-full"
      >
        <el-option
          v-for="e in publishEmployeeOptions" :key="e.id" :label="`${e.id} ${e.name}`" :value="e.id"
          :data-test="`publish-assignee-option-${e.id}`"
        />
      </el-select>
      <p class="mt-2 mb-0 text-[12px] text-gray-500">不选择员工时按岗位自动分派；选择后由该员工优先接单。</p>
      <template #footer>
        <el-button @click="publishVisible = false">取消</el-button>
        <el-button data-test="publish-confirm" type="primary" :loading="publishing" @click="confirmPublish">发布</el-button>
      </template>
    </el-dialog>

    <p v-if="loading" class="text-gray-400">加载中…</p>
    <el-empty v-else-if="tasks.length === 0" description="暂无任务，请先固化任务包" />

    <template v-else>
      <el-table :data="visibleTasks" data-test="task-table" class="rounded-xl" @row-click="openRow">
        <!-- 任务 ID 列（2026-09-11 用户反馈）：长 id（如 claude-sensitivity-config-complete）撑爆 170px
             导致换行——加宽 + 超长单行省略号悬浮看全（不换行保持行高整齐） -->
        <el-table-column prop="taskId" label="任务 ID" width="230" show-overflow-tooltip />
        <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag data-test="badge" :type="TASK_STATUS_TAG[row.status] ?? 'info'">{{ zh(TASK_STATUS_ZH, row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="领取人" width="140">
          <template #default="{ row }">
            {{ row.claimedBy ? employeeName(row.claimedBy) : row.assignee ? `已指定 ${employeeName(row.assignee)}` : '—' }}
          </template>
        </el-table-column>
        <el-table-column label="岗位" width="100">
          <template #default="{ row }">{{ row.role ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="依赖" width="120">
          <template #default="{ row }">
            <el-tag v-if="row.depsState" data-test="deps-state"
              :type="row.depsState === 'blocked' ? 'danger' : row.depsState === 'ready' ? 'success' : 'warning'">
              {{ depsLabel(row.depsState) }}
            </el-tag>
            <span v-else class="text-gray-400">—</span>
          </template>
        </el-table-column>
        <el-table-column label="计划进度" min-width="130">
          <template #default="{ row }">
            <span v-if="row.planProgress?.length" class="text-[13px]">
              {{ planProgressLabel(row.planProgress) }}
            </span>
            <span v-else class="text-gray-400">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button data-test="detail-btn" link type="primary" @click.stop="openTask(row.taskId)">详情</el-button>
            <!-- 失败任务可编辑（2026-09-10 用户需求）：配置不合理时改任务包重发（重提直接回待分派，无需再点发布） -->
            <el-button v-if="row.status === 'draft' || row.status === 'failed'" data-test="edit-btn" link type="primary" @click.stop="openEdit(row)">编辑</el-button>
            <el-button v-if="row.status === 'draft'" data-test="publish-btn" link type="success" @click.stop="openPublish(row)">发布</el-button>
            <el-button v-if="row.status === 'claimed' || row.status === 'running'" data-test="live-btn" link type="warning"
              @click.stop="router.push(`/employees/${row.claimedBy}/live`)">直播</el-button>
            <!-- 强制重置（2026-09-11 P0 韧性批）：卡死任务的管理员出路（回 pending 重新分派）；danger 语义需二次确认 -->
            <el-button v-if="row.status === 'claimed' || row.status === 'running'" data-test="force-reset-btn" link type="danger"
              @click.stop="forceReset(row)">强制重置</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p v-if="visibleTasks.length === 0" data-test="empty-filter" class="text-center text-gray-400 py-10">无匹配任务</p>
    </template>
  </section>
</template>

<style scoped>
/* 表格行可点击（进详情），与卡片版交互语义一致；EP 行内部结构需 :deep */
:deep(.el-table__row) { cursor: pointer; }
</style>
