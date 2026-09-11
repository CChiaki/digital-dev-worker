<script setup lang="ts">
// 任务依赖编排视图（2026-09-08 独立页面化）：/tasks/dag 页全宽承载（原 960px 弹窗形态移除）。
// 零依赖纯展示：任务依赖 DAG → 拓扑分层列（第 0 列无依赖，之后每列被前列阻塞/喂养）
import { computed } from 'vue';
import type { TaskSummary } from '../api.js';
import { zh, TASK_STATUS_ZH, TASK_STATUS_TAG, EVENT_TYPE_ZH, SUPERVISION_ZH, depsLabel } from '../status.js';

/** 零依赖纯展示：任务依赖 DAG → 拓扑分层列（第 0 列无依赖，之后每列被前列阻塞/喂养） */

const props = defineProps<{ tasks: TaskSummary[] }>();
const emit = defineEmits<{ open: [taskId: string] }>();

/** 环标记：levelOf 检测到依赖环时返回，同标记者统一沉入尾部「依赖环」列 */
const CYCLE = Number.MAX_SAFE_INTEGER;

/**
 * 拓扑分层：level(t) = 无依赖 ? 0 : max(level(dep)) + 1。
 * 缺失/失败依赖的任务仍进 max+1 层（blocked 必须可见，不隐藏）；
 * 防御环依赖：依赖环上（及被环阻塞）的任务统一沉入「依赖环」尾部列。
 */
function levelOf(taskId: string, cache: Map<string, number>, visiting: Set<string>): number {
  if (cache.has(taskId)) return cache.get(taskId)!;
  const t = props.tasks.find((x) => x.taskId === taskId);
  if (!t) return 0;
  const deps = t.dependsOn ?? [];
  if (deps.length === 0) {
    cache.set(taskId, 0);
    return 0;
  }
  if (visiting.has(taskId)) return CYCLE; // 环：不入常规层
  visiting.add(taskId);
  let level = 0;
  for (const d of deps) {
    const depLevel = levelOf(d, cache, visiting);
    if (depLevel === CYCLE) {
      level = CYCLE; // 被环阻塞：随环沉尾列
      break;
    }
    level = Math.max(level, depLevel + 1);
  }
  visiting.delete(taskId);
  cache.set(taskId, level);
  return level;
}

const levels = computed(() => {
  const cache = new Map<string, number>();
  const grouped = new Map<number, TaskSummary[]>();
  for (const t of props.tasks) {
    const lv = levelOf(t.taskId, cache, new Set());
    const list = grouped.get(lv) ?? [];
    list.push(t);
    grouped.set(lv, list);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([level, ts]) => ({
      level,
      label: level === CYCLE ? '依赖环（需人工处理）' : `第 ${level + 1} 层`,
      tasks: ts.sort((a, b) => a.taskId.localeCompare(b.taskId)),
    }));
});

</script>

<template>
  <div data-test="dag" class="flex gap-4 items-stretch overflow-x-auto pb-2">
    <!-- 全宽页面尺度：列均分剩余宽度（flex-1），层多时保 320px 最小宽触发横向滚动 -->
    <div v-for="l in levels" :key="l.label" data-test="dag-level" class="min-w-[320px] flex-1">
      <div class="text-gray-400 mb-2 text-xs tracking-[1px]">{{ l.label }}</div>
      <el-card
        v-for="t in l.tasks"
        :key="t.taskId"
        :data-test="`dag-card-${t.taskId}`"
        shadow="hover"
        class="dag-card w-full mb-2 cursor-pointer"
        @click="emit('open', t.taskId)"
      >
        <el-tag data-test="badge" :type="TASK_STATUS_TAG[t.status] ?? 'info'">{{ zh(TASK_STATUS_ZH, t.status) }}</el-tag>
        <el-tag v-if="t.depsState === 'blocked'" data-test="deps-blocked" type="danger">{{ depsLabel('blocked') }}</el-tag>
        <strong class="text-[13px] text-ink">{{ t.title }}</strong>
        <span class="text-gray-400 text-xs">{{ t.taskId }}</span>
        <span v-if="t.claimedBy" class="text-gray-400">· {{ t.claimedBy }}</span>
        <div v-if="t.dependsOn?.length" class="text-gray-400 w-full text-xs">← 依赖 {{ t.dependsOn.join('、') }}</div>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
/* EP 卡片内部结构：Tailwind 无法直达，保留 :deep 覆写 */
.dag-card :deep(.el-card__body) { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 12px; }
</style>
