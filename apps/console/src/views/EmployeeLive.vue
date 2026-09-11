<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { goBackOrHome } from '../router-utils.js';
import { ArrowLeft } from '@element-plus/icons-vue';
import { api, type TaskDetailRecord } from '../api.js';
import { onAgentEvent } from '../live.js';
import { zh, EVENT_TYPE_ZH } from '../status.js';
import type { AgentEvent, AgentEventType } from '@ddw/runtime';

const props = defineProps<{ employeeId?: string }>();
const router = useRouter();

// SSE 实时化（2026-09-11 P2 产品批）：事件优先经 /api/events/stream 推送到达；
// 本 interval 仅作降级兜底——SSE 在场时空转跳过，断线（未启用/代理掐断）自动恢复轮询
const POLL_MS = 2000;

type NodeStatus = 'running' | 'done' | 'failed' | 'pending';
interface NodeGroup {
  item: { id: string; title: string; kind: string };
  status: NodeStatus;
  events: AgentEvent[];
}

interface PlanTag {
  phase: 'start' | 'done' | 'failed';
  itemId?: string;
  kind?: string;
  reason?: string;
}

/** plan-runner 逐项留痕事件（type=report，payload.plan）解析；非 plan 事件返回 undefined */
function planTag(e: AgentEvent): PlanTag | undefined {
  const p = e.payload as { plan?: PlanTag } | undefined;
  return p && typeof p.plan === 'object' ? p.plan : undefined;
}

const employees = ref<{ id: string; name: string; busy: boolean; runningTasks: string[] }[]>([]);
const currentId = ref(''); // 当前观看的员工（名册中选；空 = 未过滤看全部）
const events = ref<AgentEvent[]>([]);
const seenIds = new Set<string>(); // 已渲染事件 id：轮询/SSE 双通道增量去重
const error = ref('');
let timer: ReturnType<typeof setInterval> | null = null;
let historyLoaded = false; // SSE 联通后轮询跳过；切换员工重置（历史需重新首拉）
let sseLive = false; // SSE 通路健康（收到过推送即视为在场；onerror 置 false 回落轮询）

// —— 当前任务（Task 9 直播重构）：员工 busy 时取 runningTasks[0]，多任务顶部下拉切换 ——
const currentTaskId = ref('');
const taskRecord = ref<TaskDetailRecord>();

function lastTs(): number | undefined {
  const last = events.value.at(-1);
  return last ? last.ts : undefined;
}

/** SSE 推送入列（与轮询同构：id 去重 + 员工过滤；切换员工时旧流事件自然被过滤丢弃） */
function ingest(e: AgentEvent): void {
  if (currentId.value && e.employeeId !== currentId.value) return;
  if (seenIds.has(e.id)) return;
  seenIds.add(e.id);
  events.value.push(e);
}

async function load() {
  // SSE 在场且历史已首拉：轮询空转（事件已实时到达，再查只重复）。
  // 通路健康 = 单例状态 connected 或本页收到过推送（后者防订阅建立前窗口期漏判）
  if ((sseLive || agentSub.connected()) && historyLoaded) return;
  error.value = '';
  const eid = currentId.value;
  try {
    const since = lastTs();
    const query = eid ? (since !== undefined ? { employeeId: eid, since } : { employeeId: eid }) : (since !== undefined ? { since } : {});
    const fresh = await api.listEvents(query);
    if (currentId.value !== eid) return; // 已切换员工，丢弃过期响应
    // since 是 >= 语义（同毫秒批次靠它防漏），最后一条必然重复返回——按 id 去重，
    // 否则每轮询周期重复追加一条，时间线一直刷（演示实测踩坑）
    const delta = fresh.filter((e) => !seenIds.has(e.id));
    for (const e of delta) seenIds.add(e.id);
    events.value.push(...delta);
    historyLoaded = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/** 候选任务：名册 runningTasks ∪ 事件流中出现的 taskId */
const knownTaskIds = computed(() => {
  const ids = new Set<string>();
  const roster = employees.value.find((e) => e.id === currentId.value);
  for (const t of roster?.runningTasks ?? []) ids.add(t);
  for (const e of events.value) ids.add(e.taskId);
  return [...ids];
});

/** 当前任务的事件切片（多任务并发时按选中任务过滤；未选中 = 全部） */
const scopedEvents = computed(() =>
  currentTaskId.value ? events.value.filter((e) => e.taskId === currentTaskId.value) : events.value,
);

async function loadTask() {
  const id = currentTaskId.value;
  if (!id) return;
  try {
    const rec = await Promise.resolve(api.getTask(id)).catch(() => undefined);
    if (currentTaskId.value !== id) return; // 已切换任务，丢弃过期响应
    taskRecord.value = rec;
  } catch { /* 任务详情不可用（不在任务池等）：回退整段时间线 */ }
}

watch(currentTaskId, () => void loadTask());

// 自动选中当前任务：优先名册 runningTasks[0]（busy 员工），否则取事件流中首个 taskId
watch(knownTaskIds, (ids) => {
  if (!currentTaskId.value && ids.length) currentTaskId.value = ids[0]!;
});

function selectTask(id: string) {
  if (id === currentTaskId.value) return;
  currentTaskId.value = id;
}

function selectEmployee(id: string) {
  if (id === currentId.value) return;
  currentId.value = id;
  events.value = []; // 切换直播对象：清空时间线重新拉取
  seenIds.clear();
  historyLoaded = false; // SSE 只推增量，历史须走 API 首拉
  currentTaskId.value = '';
  taskRecord.value = undefined;
  void load();
}

async function loadRoster() {
  try {
    employees.value = await api.listEmployees();
  } catch { /* 名册不可用（纯控制台模式）则回退 URL 指定员工 */ }
  if (!currentId.value) {
    const fromProps = props.employeeId;
    if (employees.value.length) {
      // 一体化模式：名册选人（URL 指定的员工在名册里则优先），默认看第一位
      currentId.value = fromProps && employees.value.some((e) => e.id === fromProps)
        ? fromProps
        : employees.value[0].id;
    } else {
      currentId.value = fromProps ?? ''; // 纯控制台模式：无名册，按 URL 指定员工过滤
    }
    void load();
  }
}

// —— 节点分组（Task 9）：plan 任务按计划项聚合事件流 ——
// 归属规则：1) payload.plan.itemId === item.id 的 plan-runner 留痕（start/done/failed）；
//          2) 该项 start 事件 ts 与下一项 start 事件 ts 之间的所有事件（含 tool_call/task_check）。
//          计划启动前的全局事件（如「计划执行：共 N 项」）挂在首项。
// 无 plan 任务：返回 null → 单组回退时间线（现有渲染路径）。
const groupedEvents = computed<NodeGroup[] | null>(() => {
  const plan = taskRecord.value?.pkg.plan;
  if (!plan?.length) return null;
  const evs = scopedEvents.value;
  const starts = new Map<string, number>();
  for (const e of evs) {
    const tag = planTag(e);
    if (tag?.phase === 'start' && tag.itemId && !starts.has(tag.itemId)) starts.set(tag.itemId, e.ts);
  }
  if (!starts.size) return null; // 计划尚未开始跑：无分组锚点，回退整段时间线
  return plan.map((item, i) => {
    const st = starts.get(item.id);
    const next = plan[i + 1] ? starts.get(plan[i + 1]!.id) : undefined;
    const own = evs.filter((e) => {
      const tag = planTag(e);
      if (tag?.itemId === item.id) return true; // 规则 1
      if (st === undefined) return false;
      if (i === 0 && e.ts < st) return true; // 计划启动前的全局事件挂在首项
      return e.ts >= st && (next === undefined || e.ts < next); // 规则 2
    });
    const uniq = new Set<string>();
    return {
      item: { id: item.id, title: item.title, kind: item.kind ?? 'dev' },
      status: groupStatus(item.id),
      events: own.filter((e) => !uniq.has(e.id) && uniq.add(e.id)),
    };
  });
});

/** 节点状态：planProgress 映射 + 最新 plan 事件校正（进行中任务进度未落库，事件流即实时状态） */
function groupStatus(itemId: string): NodeStatus {
  let latest: PlanTag | undefined;
  for (const e of scopedEvents.value) {
    const tag = planTag(e);
    if (tag?.itemId === itemId) latest = tag;
  }
  if (latest?.phase === 'done') return 'done';
  if (latest?.phase === 'failed') return 'failed';
  if (latest?.phase === 'start') return 'running';
  const p = taskRecord.value?.planProgress?.find((x) => x.itemId === itemId);
  if (p?.status === 'done') return 'done';
  if (p?.status === 'failed') return 'failed';
  return 'pending';
}

const NODE_STATUS_ZH: Record<NodeStatus, string> = { running: '进行中', done: '已完成', failed: '失败', pending: '待执行' };
const NODE_STATUS_TYPE: Record<NodeStatus, 'primary' | 'success' | 'danger' | 'info'> = {
  running: 'primary', done: 'success', failed: 'danger', pending: 'info',
};

// 折叠面板：当前节点（进行中 → 待执行 → 首项）默认展开且滚动到可见，其余折叠
const expandedGroups = ref<string[]>([]);
let lastScrolledItemId = ''; // 已滚动到的当前项：同一当前项下新事件到达不再重复滚动（不打扰上翻浏览）
watch(groupedEvents, async (groups) => {
  if (!groups) {
    expandedGroups.value = [];
    lastScrolledItemId = '';
    return;
  }
  const cur = groups.find((g) => g.status === 'running') ?? groups.find((g) => g.status === 'pending') ?? groups[0];
  if (cur && !expandedGroups.value.includes(cur.item.id)) expandedGroups.value = [cur.item.id];
  // groupedEvents 是 computed，每轮询新事件都会产生新数组引用触发本 watch；
  // 仅当前项实际切换时才滚动，避免用户上翻浏览历史时被拉回
  if (!cur || cur.item.id === lastScrolledItemId) return;
  lastScrolledItemId = cur.item.id;
  await nextTick();
  const el = document.querySelector(`[data-test="plan-node-${cur.item.id}"]`);
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
});

// —— 自动滚动（Task 9）：在底部跟随滚底；用户上翻浏览时不打扰，回到底部恢复跟随 ——
const streamRef = ref<HTMLElement>();
const nearBottom = ref(true);
function onScroll() {
  const el = streamRef.value;
  if (!el) return;
  nearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}
watch(() => events.value.length, async () => {
  await nextTick();
  if (!nearBottom.value) return;
  streamRef.value?.scrollTo?.({ top: streamRef.value.scrollHeight });
});

/** 事件类型 → 时间线节点颜色 */
const TYPE_COLOR: Partial<Record<AgentEventType, 'primary' | 'success' | 'warning' | 'danger'>> = {
  tool_call: 'primary',
  task_check: 'success',
  intervention: 'warning',
  error: 'danger',
};

// SSE 订阅（2026-09-11 P2 产品批）：事件实时入列；通路状态驱动轮询降级（jsdom 无
// EventSource 环境订阅静默跳过，轮询照常——前端测试路径不变）
const agentSub = onAgentEvent((e) => {
  sseLive = true;
  ingest(e);
});

onMounted(() => {
  void loadRoster();
  timer = setInterval(() => void load(), POLL_MS);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
  agentSub.off();
});
</script>

<template>
  <section class="view">
    <div class="flex items-center gap-3 mb-4">
      <el-button data-test="back-btn" :icon="ArrowLeft" text @click="goBackOrHome(router)">返回</el-button>
      <h2 class="!mb-0">员工直播</h2>
    </div>

    <div v-if="employees.length" class="flex gap-2 mb-4" data-test="employee-tabs">
      <el-button
        v-for="e in employees"
        :key="e.id"
        :type="e.id === currentId ? 'primary' : 'default'"
        @click="selectEmployee(e.id)"
      >
        {{ e.name }}
        <span class="text-gray-400 text-xs">{{ e.busy ? '· 执行中' : '· 空闲' }}</span>
      </el-button>
    </div>

    <el-card shadow="never" class="mb-4">
      <template #header>
        <div class="flex items-center gap-2.5">
          <span class="text-[13px] text-gray-400">当前任务</span>
          <el-select
            v-if="knownTaskIds.length > 1"
            :model-value="currentTaskId"
            class="!w-[220px]"
            data-test="task-select"
            @change="selectTask"
          >
            <el-option v-for="t in knownTaskIds" :key="t" :label="t" :value="t" />
          </el-select>
          <span v-else class="font-mono text-[13px]" data-test="task-title">{{ currentTaskId || '—' }}</span>
          <span v-if="taskRecord" class="text-gray-400">{{ taskRecord.pkg.title }}</span>
        </div>
      </template>

      <div ref="streamRef" class="max-h-[60vh] overflow-y-auto" @scroll="onScroll">
        <!-- plan 任务：按计划项分组的节点视图 -->
        <el-collapse v-if="groupedEvents" :model-value="expandedGroups" data-test="plan-nodes">
          <el-collapse-item
            v-for="(g, i) in groupedEvents"
            :key="g.item.id"
            :name="g.item.id"
            :data-test="`plan-node-${g.item.id}`"
          >
            <template #title>
              <span class="mr-2.5 text-[13px]">第 {{ i + 1 }} 项 · {{ g.item.title }}</span>
              <el-tag :type="NODE_STATUS_TYPE[g.status]" class="ml-2">{{ NODE_STATUS_ZH[g.status] }}</el-tag>
            </template>
            <el-timeline v-if="g.events.length" class="pl-1">
              <el-timeline-item
                v-for="e in g.events"
                :key="e.id"
                data-test="event-item"
                :class="`event-${e.type}`"
                :type="TYPE_COLOR[e.type]"
                :timestamp="new Date(e.ts).toLocaleTimeString()"
              >
                <span class="text-xs text-gray-600 mr-2.5 min-w-[72px] inline-block">{{ zh(EVENT_TYPE_ZH, e.type) }}</span>
                <span class="text-[13px]">{{ e.summary }}</span>
              </el-timeline-item>
            </el-timeline>
            <p v-else class="text-gray-400">本项暂无事件</p>
          </el-collapse-item>
        </el-collapse>

        <!-- 回退：无 plan / 计划未开始 → 整段时间线 -->
        <el-timeline v-else-if="scopedEvents.length" class="pl-1">
          <el-timeline-item
            v-for="e in scopedEvents"
            :key="e.id"
            data-test="event-item"
            :class="`event-${e.type}`"
            :type="TYPE_COLOR[e.type]"
            :timestamp="new Date(e.ts).toLocaleTimeString()"
          >
            <span class="text-xs text-gray-600 mr-2.5 min-w-[72px] inline-block">{{ zh(EVENT_TYPE_ZH, e.type) }}</span>
            <span class="text-[13px]">{{ e.summary }}</span>
          </el-timeline-item>
        </el-timeline>
        <p v-else-if="!error" class="text-gray-400">暂无事件，等待员工开始工作…</p>
        <el-alert v-if="error" data-test="error" :title="error" type="error" :closable="false" show-icon />
      </div>
    </el-card>
  </section>
</template>
