<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElNotification } from 'element-plus';
import { Bell } from '@element-plus/icons-vue';
import { api, type MessageView } from '../api.js';
import { onLiveMessage, useLiveCounts } from '../live.js';

/** 消息类型 → 中文 tag / 颜色（与 brief 对齐：待放行=warning / 失败=danger / 完成=success；skill_pending=Skill 待审查） */
const TYPE_LABEL: Record<MessageView['type'], string> = { review_required: '待放行', task_failed: '失败', task_done: '完成', skill_pending: 'Skill 待审查' };
const TYPE_TAG: Record<MessageView['type'], 'warning' | 'danger' | 'success'> = { review_required: 'warning', task_failed: 'danger', task_done: 'success', skill_pending: 'warning' };
/** 弹窗级别：失败 error 红、待放行/Skill 待审查 info、完成 success */
const NOTIFY_TYPE: Record<MessageView['type'], 'error' | 'info' | 'success'> = { review_required: 'info', task_failed: 'error', task_done: 'success', skill_pending: 'info' };

const router = useRouter();
/** 未读数来自 SSE counts 推送（2026-09-10 改推送不轮询）：已读/新消息后服务端重算下发 */
const live = useLiveCounts();
const unread = computed(() => live.unread);

const drawerVisible = ref(false);

/** 过滤 + 分页（2026-09-10 重设计）：服务端 type/q/unreadOnly 过滤 + 分页，消息量大不再整页渲染 */
const filterType = ref('');
const keyword = ref('');
const unreadOnly = ref(false);
const page = ref(1);
const PAGE_SIZE = 20;
const messages = ref<MessageView[]>([]);
const total = ref(0);
const loading = ref(false);

async function loadPage(): Promise<void> {
  loading.value = true;
  try {
    const r = await api.listMessages({
      type: filterType.value || undefined,
      q: keyword.value.trim() || undefined,
      unreadOnly: unreadOnly.value || undefined,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
    });
    messages.value = r.messages;
    total.value = r.total;
  } catch {
    // 消息中心未启用/后端离线时静默（铃铛不炸顶栏）
  } finally {
    loading.value = false;
  }
}

// 筛选变化回第一页重查；关键词 300ms 防抖（逐键不刷请求）
let keywordTimer: ReturnType<typeof setTimeout> | undefined;
watch([filterType, unreadOnly], () => {
  page.value = 1;
  void loadPage();
});
watch(keyword, () => {
  clearTimeout(keywordTimer);
  keywordTimer = setTimeout(() => {
    page.value = 1;
    void loadPage();
  }, 300);
});
watch(page, () => void loadPage());
// 抽屉打开即刷新（关闭期间推送来的消息这次拉到）
watch(drawerVisible, (open) => {
  if (open) void loadPage();
});

/** 新消息推送（2026-09-10）：抽屉开着只刷新列表不弹窗；关着弹通知直达任务 */
const notified = new Set<string>();
let offLive: (() => void) | undefined;
onMounted(() => {
  offLive = onLiveMessage((m) => {
    if (drawerVisible.value) {
      notified.add(m.id);
      void loadPage();
      return;
    }
    if (notified.has(m.id)) return;
    notified.add(m.id);
    ElNotification({
      title: m.title,
      message: m.summary,
      type: NOTIFY_TYPE[m.type],
      duration: 8000,
      onClick: () => void openMessage(m),
    });
  });
});
onBeforeUnmount(() => {
  offLive?.();
  clearTimeout(keywordTimer);
});

function relTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 单条直达：标记已读 → 跳任务详情 → 关抽屉（未读数由服务端 counts 推送更新） */
async function openMessage(m: MessageView) {
  drawerVisible.value = false;
  try {
    if (m.readAt === undefined) await api.markMessageRead(m.id);
  } catch {
    // 已读标记失败不阻断跳转
  }
  await router.push(`/tasks/${m.taskId}`);
}

/** 全部已读：未读数走服务端 counts 推送；本页消息即时置已读 */
async function readAll() {
  try {
    await api.markAllMessagesRead();
    messages.value = messages.value.map((m) => (m.readAt === undefined ? { ...m, readAt: Date.now() } : m));
  } catch {
    // 静默：推送自愈
  }
}

defineExpose({ loadPage });
</script>

<template>
  <span class="inline-flex ml-auto">
    <el-badge :value="unread" :max="99" :hidden="unread === 0">
      <el-button data-test="bell-btn" circle text :icon="Bell" class="!text-white !text-[18px]" @click="drawerVisible = true" />
    </el-badge>

    <el-drawer v-model="drawerVisible" title="消息中心" size="480px">
      <div data-test="drawer-body" class="flex flex-col gap-2.5" v-show="drawerVisible">
        <!-- 过滤查询（2026-09-10 重设计）：类型 + 关键词 + 只看未读 -->
        <div class="flex items-center gap-2">
          <el-select
            v-model="filterType"
            data-test="msg-filter-type"
            placeholder="全部类型"
            clearable
            class="!w-32"
            :teleported="false"
          >
            <el-option v-for="(label, t) in TYPE_LABEL" :key="t" :label="label" :value="t" :data-test="`msg-type-option-${t}`" />
          </el-select>
          <el-input
            v-model="keyword"
            data-test="msg-filter-keyword"
            placeholder="搜索任务 / 标题 / 摘要"
            clearable
            class="flex-1"
          />
          <el-checkbox v-model="unreadOnly" data-test="msg-filter-unread">只看未读</el-checkbox>
        </div>

        <div class="flex items-center justify-between">
          <span class="text-gray-400">共 {{ total }} 条 · {{ unread }} 条未读</span>
          <el-button data-test="read-all-btn" :disabled="unread === 0" @click="readAll">全部已读</el-button>
        </div>

        <div v-loading="loading" class="min-h-24">
          <el-empty v-if="messages.length === 0 && !loading" description="暂无消息" />
          <div
            v-for="m in messages"
            :key="m.id"
            :data-test="`msg-item-${m.id}`"
            class="py-2.5 px-3 border border-[#eef1f6] rounded-lg cursor-pointer transition-colors hover:bg-[#f5f8ff]"
            :class="m.readAt === undefined ? 'border-l-[3px] border-l-brand-600 bg-[#f7f9ff]' : ''"
            @click="openMessage(m)"
          >
            <div class="flex items-center gap-2">
              <el-tag :data-test="`msg-tag-${m.id}`" :type="TYPE_TAG[m.type]">{{ TYPE_LABEL[m.type] }}</el-tag>
              <span v-if="m.readAt === undefined" :data-test="`unread-dot-${m.id}`" class="w-[7px] h-[7px] rounded-full bg-danger shrink-0" />
              <span class="ml-auto text-xs text-gray-400">{{ relTime(m.createdAt) }}</span>
            </div>
            <div class="mt-1.5 text-sm" :class="m.readAt === undefined ? 'font-bold' : ''">{{ m.title }}</div>
            <div class="mt-0.5 text-xs leading-normal text-gray-400">{{ m.summary }}</div>
          </div>
        </div>

        <!-- 分页（2026-09-10）：消息量大分页拉取，不再一次全渲染 -->
        <el-pagination
          v-if="total > PAGE_SIZE"
          v-model:current-page="page"
          :page-size="PAGE_SIZE"
          :total="total"
          layout="prev, pager, next"
          data-test="msg-pagination"
          class="mt-1 justify-center"
        />
      </div>
    </el-drawer>
  </span>
</template>
