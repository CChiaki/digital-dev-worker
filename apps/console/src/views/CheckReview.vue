<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, type CheckRecordView } from '../api.js';

const records = ref<CheckRecordView[]>([]);
const loading = ref(false);
const error = ref('');
const message = ref('');
const rejecting = ref(''); // 正在填写驳回意见的 key（taskId::item）
const comment = ref('');
let timer: ReturnType<typeof setInterval> | undefined;

/** 视图过滤（2026-09-10 用户需求）：默认只看待办（可操作），可切全部放行记录（含历史裁决/已失效） */
const scope = ref<'pending' | 'all'>('pending');

const keyOf = (c: CheckRecordView): string => `${c.taskId}::${c.item}`;

/** 检索区（2026-09-06 表格化改造）：按任务 ID 关键词过滤（大小写不敏感） */
const keyword = ref('');
const matches = (c: CheckRecordView): boolean =>
  !keyword.value.trim() || c.taskId.toLowerCase().includes(keyword.value.trim().toLowerCase());
const filtered = computed(() => records.value.filter(matches));
defineExpose({ matches });

/** 状态标签：待审（可操作）/ 已放行 / 已驳回 / 已作废（人工作废留痕）/ 已失效（任务结束仍无裁决，放行必 404） */
const statusOf = (c: CheckRecordView): { text: string; type: 'warning' | 'success' | 'danger' | 'info' } => {
  if (c.voided) return { text: '已作废', type: 'info' };
  if (c.expired) return { text: '已失效', type: 'info' };
  if (c.pending) return { text: '待审', type: 'warning' };
  return c.approved ? { text: '已放行', type: 'success' } : { text: '已驳回', type: 'danger' };
};

/** 时间格式（短）：MM-dd HH:mm */
const fmt = (ts?: number): string => {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function load() {
  loading.value = true;
  error.value = '';
  try {
    // 全部视图用 /api/checks/history（含已裁决/已失效）；待办视图取其 pending 子集——
    // 同源同口径（角标 = /api/checks 同样按任务存活过滤），页面数字与菜单角标一致
    const all = await api.listCheckHistory();
    records.value = scope.value === 'pending' ? all.filter((c) => c.pending && !c.expired) : all;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function review(c: CheckRecordView, approved: boolean, reviewComment?: string) {
  error.value = '';
  message.value = '';
  try {
    await api.reviewCheck(c.taskId, c.item, approved, reviewComment);
    message.value = `${c.taskId} / ${c.item} 已${approved ? '放行' : '驳回'}`;
    rejecting.value = '';
    comment.value = '';
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function openReject(c: CheckRecordView) {
  rejecting.value = keyOf(c);
  comment.value = '';
}

/** 作废失效待审（2026-09-11 P1 治理批）：任务已结束的残留待审（放行必 404）写 intervention
 *  留痕清待——不确认直接作废（操作本身可从审计台账追溯，服务端 409 挡执行中任务） */
async function voidExpired(c: CheckRecordView) {
  error.value = '';
  message.value = '';
  try {
    await api.voidCheck(c.taskId, c.item);
    message.value = `${c.taskId} / ${c.item} 已作废（审计链留痕）`;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(() => {
  void load();
  timer = setInterval(load, 5000); // 待审轮询
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <section class="view">
    <h2>人工放行</h2>
    <el-alert v-if="error" data-test="error" :title="error" type="error" :closable="false" show-icon class="mb-3" />
    <el-alert v-if="message" data-test="message" :title="message" type="success" :closable="false" show-icon class="mb-3" />
    <div class="mb-4 flex items-center gap-3">
      <el-radio-group v-model="scope" data-test="check-scope" @change="load">
        <el-radio-button value="pending">待办</el-radio-button>
        <el-radio-button value="all">全部记录</el-radio-button>
      </el-radio-group>
      <el-input
        v-model="keyword"
        data-test="check-search"
        placeholder="按任务 ID 检索"
        clearable
        class="!w-64"
      />
    </div>
    <el-table
      :data="filtered"
      class="check-table"
      data-test="check-table"
      :empty-text="scope === 'pending'
        ? '暂无待审节点。shadow 级数字员工申报任务节点后会出现在这里。'
        : '暂无放行记录'"
    >
      <el-table-column label="任务 ID" min-width="160">
        <template #default="{ row }">
          <span :data-test="`check-${row.taskId}-${row.item}`">{{ row.taskId }}</span>
        </template>
      </el-table-column>
      <el-table-column label="检查项" min-width="120">
        <template #default="{ row }">
          <el-tag data-test="item" :type="row.bash ? 'primary' : 'warning'">
            {{ row.item }}{{ row.bash ? '（命令）' : '' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="result" :label="scope === 'all' ? '申报结果 / 命令' : '申报结果'" min-width="220" show-overflow-tooltip />
      <el-table-column v-if="scope === 'all'" label="状态" width="100">
        <template #default="{ row }">
          <el-tag data-test="check-status" :type="statusOf(row).type">{{ statusOf(row).text }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column v-if="scope === 'all'" label="裁决意见" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">
          <span>{{ row.comment ?? (row.pending ? '—' : '') }}</span>
        </template>
      </el-table-column>
      <el-table-column v-if="scope === 'all'" label="裁决人" width="90">
        <!-- 2026-09-11 API token 操作者留痕：服务端未启用鉴权/历史数据无值显示 — -->
        <template #default="{ row }">{{ row.operator ?? (row.pending ? '—' : '') }}</template>
      </el-table-column>
      <el-table-column v-if="scope === 'all'" label="申报时间" width="120">
        <template #default="{ row }">{{ fmt(row.checkTs) }}</template>
      </el-table-column>
      <el-table-column v-if="scope === 'all'" label="裁决时间" width="120">
        <template #default="{ row }">{{ fmt(row.verdictTs) }}</template>
      </el-table-column>
      <!-- 作废（2026-09-11 P1 治理批）：全部记录里对「已失效待审」可作废留痕清待 -->
      <el-table-column v-if="scope === 'all'" label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="row.pending && row.expired"
            data-test="void-btn"
            link
            type="danger"
            @click="voidExpired(row)"
          >作废</el-button>
          <span v-else class="text-gray-400">—</span>
        </template>
      </el-table-column>
      <el-table-column v-if="scope === 'pending'" label="操作" width="230" fixed="right">
        <template #default="{ row }">
          <el-button data-test="approve-btn" type="success" @click="review(row, true)">放行</el-button>
          <el-button data-test="reject-btn" type="danger" plain @click="openReject(row)">驳回</el-button>
          <div v-if="rejecting === keyOf(row)" class="flex gap-2 mt-2">
            <el-input
              v-model="comment"
              data-test="comment-input"
              placeholder="驳回意见（员工会看到并按意见修正）"
              class="flex-1"
            />
            <el-button data-test="confirm-reject-btn" type="danger" @click="review(row, false, comment)">确认驳回</el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>
