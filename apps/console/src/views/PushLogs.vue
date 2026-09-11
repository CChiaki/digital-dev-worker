<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type PushLogView } from '../api.js';

const logs = ref<PushLogView[]>([]);
const loading = ref(false);
const error = ref('');

/** 过滤（2026-09-10 用户需求）：taskId 关键词 + 状态（全部/成功/失败） */
const keyword = ref('');
const status = ref<'all' | 'sent' | 'failed'>('all');

const filtered = computed(() => logs.value.filter((l) => {
  const kw = keyword.value.trim().toLowerCase();
  const hit = !kw
    || l.taskId.toLowerCase().includes(kw)
    || l.messageTitle.toLowerCase().includes(kw)
    || l.channelName.toLowerCase().includes(kw)
    || (l.yanxunSeqNo ?? '').toLowerCase().includes(kw);
  return hit && (status.value === 'all' || l.status === status.value);
}));

/** 时间格式：yyyy-MM-dd HH:mm:ss */
const fmt = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

async function load() {
  loading.value = true;
  error.value = '';
  try {
    logs.value = await api.listPushLogs({ limit: 500 });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section class="view">
    <h2>推送记录</h2>
    <el-alert v-if="error" data-test="error" :title="error" type="error" :closable="false" show-icon class="mb-3" />
    <div class="mb-4 flex items-center gap-3">
      <el-radio-group v-model="status" data-test="push-status-filter">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="sent">推送成功</el-radio-button>
        <el-radio-button value="failed">推送失败</el-radio-button>
      </el-radio-group>
      <el-input
        v-model="keyword"
        data-test="push-search"
        placeholder="按任务 ID / 消息 / 渠道 / 流水号检索"
        clearable
        class="!w-72"
      />
      <el-button data-test="push-refresh" :loading="loading" @click="load">刷新</el-button>
    </div>
    <el-table :data="filtered" data-test="push-table" empty-text="暂无推送记录。消息中心生成消息后会向启用渠道推送，逐条留痕。">
      <el-table-column label="时间" width="170">
        <template #default="{ row }">{{ fmt(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="消息" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">{{ row.messageTitle }}</template>
      </el-table-column>
      <el-table-column label="任务 ID" min-width="160" show-overflow>
        <template #default="{ row }">
          <router-link :to="`/tasks/${row.taskId}`" class="text-[color:var(--color-brand-600)]">{{ row.taskId }}</router-link>
        </template>
      </el-table-column>
      <el-table-column label="渠道" min-width="130">
        <template #default="{ row }">
          <span>{{ row.channelName }}</span>
          <el-tag size="small" class="ml-1" type="info">{{ row.channelType }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'sent' ? 'success' : 'danger'" data-test="push-status">
            {{ row.status === 'sent' ? '已推送' : '失败' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="燕讯流水号" min-width="230" show-overflow-tooltip>
        <template #default="{ row }">
          <span data-test="push-seqno">{{ row.yanxunSeqNo ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="失败原因" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">{{ row.error ?? '' }}</template>
      </el-table-column>
    </el-table>
  </section>
</template>
