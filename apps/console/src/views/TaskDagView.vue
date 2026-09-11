<script setup lang="ts">
// 编排视图独立页面（2026-09-08 用户反馈：960px 弹窗效果差 → 独立页 /tasks/dag 全宽承载 DAG）
// 数据源与刷新逻辑保持弹窗版口径：全量任务（api.listTasks）保证分层正确，不随检索过滤
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { goBackOrHome } from '../router-utils.js';
import { ArrowLeft } from '@element-plus/icons-vue';
import { api, type TaskSummary } from '../api.js';
import TaskDag from '../components/TaskDag.vue';

const router = useRouter();

const tasks = ref<TaskSummary[]>([]);
const loading = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    tasks.value = await api.listTasks();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/** 点卡片进任务详情（对齐任务中心行点击路由口径） */
function openTask(taskId: string) {
  void router.push(`/tasks/${taskId}`);
}

onMounted(load);
</script>

<template>
  <section class="view">
    <div class="flex items-center gap-3 mb-4">
      <el-button data-test="back-btn" :icon="ArrowLeft" text @click="goBackOrHome(router)">返回</el-button>
      <h2 class="!mb-0">编排视图</h2>
    </div>

    <el-alert v-if="error" data-test="error" :title="error" type="error" :closable="false" show-icon />

    <p v-else-if="loading" class="text-gray-400">加载中…</p>

    <template v-else>
      <TaskDag v-if="tasks.length" :tasks="tasks" @open="openTask" />
      <el-empty v-else description="暂无任务，请先固化任务包" />
      <p v-if="tasks.length" class="mt-3 mb-0 text-[12px] text-gray-500">按依赖拓扑分层展示（左 → 右为执行顺序）；点击卡片进入任务详情。</p>
    </template>
  </section>
</template>
