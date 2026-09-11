<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { employeeName, ensureEmployeeNames } from '../employee-names.js';
import type { AgentEvent, AgentEventType } from '@ddw/runtime';
import { zh, EVENT_TYPE_ZH } from '../status.js';

const TYPES: (AgentEventType | 'all')[] = ['all', 'thinking', 'tool_call', 'task_check', 'diff', 'report', 'intervention', 'error', 'config_change'];

/** 分批加载（2026-09-10 用户需求）：默认 200 条，底部「加载更多」再拉一批——
 *  过滤/分页均在服务端做（/api/audit?type&limit&offset），事件量大时不再全量传输拖慢首屏 */
const BATCH = 200;

const events = ref<AgentEvent[]>([]);
const total = ref(0);
const byType = ref<Record<string, number>>({});
const loading = ref(false);
const error = ref('');
const typeFilter = ref<'all' | AgentEventType>('all');
/** 完整性徽标（2026-09-11 P1 治理批）：服务端定时（启动+每日）与手动校验的最近结果 */
const lastIntegrity = ref<{ ok: boolean; at: number; total: number; brokenAt?: string } | undefined>();
const verifying = ref(false);

const TYPE_TAG: Partial<Record<AgentEventType, 'primary' | 'success' | 'warning' | 'danger' | 'info'>> = {
  tool_call: 'primary',
  task_check: 'success',
  intervention: 'warning',
  error: 'danger',
  thinking: 'info',
};

async function fetchBatch(offset: number, append: boolean): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    void ensureEmployeeNames(); // 姓名映射并行拉取（失败静默回退显示 id，不阻塞台账）
    const r = await api.audit({
      type: typeFilter.value === 'all' ? undefined : typeFilter.value,
      limit: BATCH,
      offset,
    });
    total.value = r.total;
    byType.value = r.byType;
    lastIntegrity.value = r.lastIntegrity;
    events.value = append ? [...events.value, ...r.events] : r.events;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/** 筛选变化：回到第一批重新拉取 */
watch(typeFilter, () => void fetchBatch(0, false));

/** 立即校验（2026-09-11 P1 治理批）：即时全链重算（事件量大时秒级），结果回填徽标 */
async function verifyNow() {
  verifying.value = true;
  try {
    lastIntegrity.value = await api.verifyAudit();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    verifying.value = false;
  }
}

onMounted(() => void fetchBatch(0, false));
</script>

<template>
  <section class="view">
    <h2>审计台账</h2>

    <el-alert v-if="error" data-test="error" :title="error" type="error" :closable="false" show-icon class="mb-3" />

    <!-- 工具条（2026-09-06 列表页风格统一）：类型筛选左置，计数汇总右置；radio 交互不变 -->
    <div class="flex items-center gap-3 flex-wrap mb-4">
      <el-radio-group v-model="typeFilter" data-test="type-filter">
        <!-- value 保持英文数据值，展示转中文 -->
        <el-radio-button v-for="t in TYPES" :key="t" :value="t">{{ t === 'all' ? '全部' : zh(EVENT_TYPE_ZH, t) }}</el-radio-button>
      </el-radio-group>
      <span class="ml-auto text-[13px]">
        <!-- 完整性徽标（2026-09-11 P1 治理批）：篡改/断链常驻可见；hover 看校验时间与断点 -->
        <el-tooltip
          v-if="lastIntegrity"
          :content="`最近校验 ${new Date(lastIntegrity.at).toLocaleString()} · 重算 ${lastIntegrity.total} 条事件${lastIntegrity.brokenAt ? ` · 首断点 ${lastIntegrity.brokenAt}` : ''}`"
        >
          <el-tag :type="lastIntegrity.ok ? 'success' : 'danger'" class="mr-2" data-test="integrity-badge">
            {{ lastIntegrity.ok ? '完整性校验通过' : '完整性校验失败' }}
          </el-tag>
        </el-tooltip>
        <el-button data-test="verify-btn" size="small" :loading="verifying" class="mr-2" @click="verifyNow">
          立即校验
        </el-button>
        展示 {{ events.length }}/{{ total }} 条
        <span v-for="(n, t) in byType" :key="t" class="ml-2 text-gray-600 text-[13px]">· {{ zh(EVENT_TYPE_ZH, t) }}: {{ n }}</span>
      </span>
    </div>

    <el-table v-loading="loading" :data="events" class="audit-table" data-test="audit-table">
      <el-table-column label="时间" width="110">
        <template #default="{ row }">{{ new Date(row.ts).toLocaleTimeString() }}</template>
      </el-table-column>
      <el-table-column label="类型" width="120">
        <template #default="{ row }">
          <el-tag :type="TYPE_TAG[row.type as AgentEventType] ?? 'info'">{{ zh(EVENT_TYPE_ZH, row.type) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="员工" width="140">
        <template #default="{ row }">{{ employeeName(row.employeeId) }}</template>
      </el-table-column>
      <el-table-column prop="taskId" label="任务" width="200" show-overflow-tooltip />
      <el-table-column prop="summary" label="摘要" min-width="300" show-overflow-tooltip />
    </el-table>

    <!-- 底部加载更多（2026-09-10）：滚到最底下出现，点击再加载一批 -->
    <div v-if="events.length < total" class="mt-4 text-center">
      <el-button data-test="audit-load-more" :loading="loading" @click="fetchBatch(events.length, true)">
        加载更多（剩余 {{ total - events.length }} 条）
      </el-button>
    </div>
  </section>
</template>
