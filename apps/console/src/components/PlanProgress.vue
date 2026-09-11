<script setup lang="ts">
import type { PlanItem } from '@ddw/runtime';
import type { PlanProgress } from '../api.js';

const props = defineProps<{
  progress?: PlanProgress[];
  failedItemId?: string;
  /** 执行中项（2026-09-06 用户反馈）：任务 running 时第一个待执行项——续跑复位后即时可见 */
  activeItemId?: string;
  /** 计划明细（2026-09-06 用户反馈）：悬浮节点展示任务包 yml 的完整任务信息（要求/验收命令） */
  planItems?: PlanItem[];
}>();

/** 计划明细查找：progress 只是执行态快照（id/kind/title/status），detail/verify 在 pkg.plan */
function itemOf(p: PlanProgress): PlanItem | undefined {
  return props.planItems?.find((i) => i.id === p.itemId);
}

/** 计划项状态 → el-timeline 节点语义色（2026-09-05 计划模式）：
 *  done=success 已完成、failed=danger 停点高亮、skipped=info 待执行 */
const STATUS_TYPE: Record<string, 'success' | 'danger' | 'info' | 'warning'> = {
  done: 'success',
  failed: 'danger',
  skipped: 'info',
  running: 'warning',
};

const STATUS_ZH: Record<string, string> = { done: '已完成', failed: '失败', skipped: '待执行', running: '执行中' };

/** 展示态（2026-09-06 用户反馈）：执行中项（activeItemId）按 running 渲染——
 *  DB 只存 done/failed/skipped 终态，running 是纯展示态（纯函数便于测试） */
function displayStatus(p: PlanProgress): string {
  return p.itemId === props.activeItemId && p.status === 'skipped' ? 'running' : p.status;
}
</script>

<template>
  <div v-if="props.progress?.length" data-test="plan-progress" class="mt-7">
    <el-timeline>
      <el-timeline-item
        v-for="p in props.progress"
        :key="p.itemId"
        :type="STATUS_TYPE[displayStatus(p)] ?? 'info'"
        :hollow="p.status === 'skipped' && p.itemId !== props.activeItemId"
        :class="{ 'failed-item': p.itemId === props.failedItemId }"
        :data-test="`plan-item-${p.itemId}`"
      >
        <el-tooltip placement="top" :show-after="150" persistent>
          <template #content>
            <div data-test="plan-tip" class="max-w-[460px] leading-relaxed">
              <p class="m-0 font-semibold">{{ itemOf(p)?.title ?? p.title }}</p>
              <p class="m-0 mt-1 whitespace-pre-wrap">要求：{{ itemOf(p)?.detail ?? '（任务包无该项明细）' }}</p>
              <p v-if="itemOf(p)?.verify" class="m-0 mt-1">验收命令：<span class="font-mono">{{ itemOf(p)!.verify }}</span></p>
            </div>
          </template>
          <span class="cursor-help">
            <span class="mr-2" :class="p.itemId === props.failedItemId ? 'text-danger font-semibold' : ''">{{ p.title }}</span>
            <el-tag class="font-mono mr-1.5">{{ p.kind }}</el-tag>
            <el-tag
              :type="STATUS_TYPE[displayStatus(p)] ?? 'info'"
              :effect="p.itemId === props.failedItemId ? 'dark' : 'light'"
            >{{ STATUS_ZH[displayStatus(p)] ?? displayStatus(p) }}</el-tag>
          </span>
        </el-tooltip>
      </el-timeline-item>
    </el-timeline>
  </div>
</template>
