<script setup lang="ts">
import { markRaw, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Bell, CircleCheck, Coin, Loading, WarningFilled } from '@element-plus/icons-vue';
import { api, type EmployeeRecordView } from '../api.js';
import { zh, SUPERVISION_ZH } from '../status.js';

// 首页面板（2026-09-06）：员工卡片区 + 任务统计四卡；5s 轮询
const router = useRouter();

// 统计卡图标（markRaw 防止组件对象被响应式代理；仅视图配置，无逻辑）
const STAT_ICONS = {
  Loading: markRaw(Loading),
  CircleCheck: markRaw(CircleCheck),
  WarningFilled: markRaw(WarningFilled),
  Bell: markRaw(Bell),
  Coin: markRaw(Coin),
} as const;

const employees = ref<EmployeeRecordView[]>([]);
const stats = ref({ running: 0, done: 0, failed: 0, checks: 0 });
// token 累计（2026-09-11 P2 产品批）：done 任务 result.tokenUsage 求和，成本可见性
const tokens = ref({ input: 0, output: 0, calls: 0 });
const doneCount = ref<Record<string, number>>({}); // employeeId → 完成任务数
const error = ref('');
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  error.value = '';
  try {
    const [emps, running, done, failed, checks] = await Promise.all([
      api.listEmployees(),
      api.listTasksFiltered({ status: 'claimed,running' }),
      api.listTasksFiltered({ status: 'done' }),
      api.listTasksFiltered({ status: 'failed' }),
      api.listChecks(),
    ]);
    employees.value = emps;
    stats.value = { running: running.length, done: done.length, failed: failed.length, checks: checks.length };
    // token Σ 聚合：只计 done 任务的 result 账本（无用量旧任务自然跳过）
    const sum = { input: 0, output: 0, calls: 0 };
    for (const t of done) {
      if (!t.tokenUsage) continue;
      sum.input += t.tokenUsage.input;
      sum.output += t.tokenUsage.output;
      sum.calls += t.tokenUsage.calls;
    }
    tokens.value = sum;
    const byEmp: Record<string, number> = {};
    for (const t of done) {
      if (!t.claimedBy) continue;
      byEmp[t.claimedBy] = (byEmp[t.claimedBy] ?? 0) + 1;
    }
    doneCount.value = byEmp;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(() => {
  void load();
  timer = setInterval(load, 5000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <section class="view">
    <h2>首页面板</h2>

    <el-alert v-if="error" data-test="error" :title="error" type="error" :closable="false" show-icon class="mb-4" />

    <!-- 任务统计四卡：进行中 = claimed+running；待放行 = 人工盯梢队列 -->
    <el-row :gutter="16" class="mb-6">
      <el-col :span="6" v-for="s in [
        { key: 'stat-running',  icon: 'Loading',       cls: 'bg-brand-50 text-brand-600', num: stats.running, label: '进行中' },
        { key: 'stat-done',     icon: 'CircleCheck',   cls: 'bg-green-50 text-green-600', num: stats.done,    label: '已完成' },
        { key: 'stat-failed',   icon: 'WarningFilled', cls: 'bg-red-50 text-red-600',     num: stats.failed,  label: '失败（点击查看）', danger: true },
        { key: 'stat-checks',   icon: 'Bell',          cls: 'bg-orange-50 text-orange-500', num: stats.checks, label: '待放行' },
      ]" :key="s.key">
        <el-card :data-test="s.key" shadow="never"
          :class="['rounded-xl', s.danger ? 'cursor-pointer hover:shadow-md' : '']"
          @click="s.danger && router.push('/tasks')">
          <div class="flex items-center gap-4">
            <span :class="['stat-icon', 'w-11 h-11 rounded-lg flex items-center justify-center text-xl', s.cls]">
              <el-icon><component :is="STAT_ICONS[s.icon as keyof typeof STAT_ICONS]" /></el-icon>
            </span>
            <div>
              <div class="text-[28px] font-bold leading-tight" :class="s.danger ? 'text-red-500' : ''">{{ s.num }}</div>
              <div class="text-gray-400 text-[13px]">{{ s.label }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- token 累计条（2026-09-11 P2 产品批）：done 任务用量 Σ 聚合，成本可见性；零用量隐藏（旧任务无账本） -->
    <el-card v-if="tokens.calls > 0" data-test="stat-tokens" shadow="never" class="rounded-xl mb-6">
      <div class="flex items-center gap-4">
        <span class="stat-icon w-11 h-11 rounded-lg flex items-center justify-center text-xl bg-violet-50 text-violet-500">
          <el-icon><component :is="STAT_ICONS.Coin" /></el-icon>
        </span>
        <div class="flex items-baseline gap-6 flex-wrap">
          <span class="text-[13px] text-gray-400">累计 Token（{{ stats.done }} 单已完成任务）</span>
          <span class="font-mono text-[15px]">
            输入 <strong class="text-[20px]">{{ tokens.input.toLocaleString() }}</strong>
            <span class="text-gray-300 mx-1">/</span>
            输出 <strong class="text-[20px]">{{ tokens.output.toLocaleString() }}</strong>
            <span class="text-gray-300 mx-1">·</span>
            <span class="text-gray-400">{{ tokens.calls.toLocaleString() }} 次模型调用</span>
          </span>
        </div>
      </div>
    </el-card>

    <!-- 员工卡片区：浅灰分区 + 点击下钻员工详情 -->
    <p v-if="!error && employees.length === 0" class="text-gray-400">暂无员工档案，前往「数字员工」页新增。</p>
    <div v-else data-test="emp-section" class="bg-gray-50 rounded-xl p-4 -mx-2">
      <h3 class="text-[15px] font-semibold text-gray-700 mb-3 pl-2 border-l-4 border-brand-600">数字员工</h3>
      <el-row :gutter="16">
        <el-col v-for="e in employees" :key="e.id" :xs="24" :sm="12" :md="8">
          <el-card :data-test="`employee-${e.id}`" shadow="hover" class="rounded-xl cursor-pointer mb-4"
            :class="{ 'opacity-55 grayscale': e.enabled === false }"
            @click="router.push(`/employees/${e.id}`)">
            <div class="flex items-center gap-3">
              <!-- 首字母徽章：忙=主色 / 闲=绿 / 停用=灰 -->
              <span class="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold shrink-0"
                :class="e.enabled === false ? 'bg-gray-300' : e.busy ? 'bg-brand-600' : 'bg-green-500'">
                {{ e.name.charAt(0) }}
              </span>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <strong class="text-[15px]">{{ e.name }}</strong>
                  <span class="flex items-center gap-1 text-xs" :class="e.busy ? 'text-brand-600' : 'text-green-600'">
                    <span class="w-1.5 h-1.5 rounded-full" :class="e.busy ? 'bg-brand-600' : 'bg-green-500'"></span>
                    {{ e.busy ? '执行中' : '空闲' }}
                  </span>
                  <el-tag v-if="e.enabled === false" type="info" effect="plain">已停用</el-tag>
                </div>
                <div class="text-gray-400 text-[13px] mt-0.5">{{ (e.roles ?? []).join('、') }} · 盯梢 {{ zh(SUPERVISION_ZH, e.supervision) }}</div>
              </div>
            </div>
            <div class="mt-2 flex flex-wrap gap-1">
              <el-tag v-for="c in e.capabilities ?? []" :key="c" type="warning" class="cap-tag">{{ c }}</el-tag>
              <span v-if="!(e.capabilities ?? []).length" class="text-gray-400 text-xs">全部能力</span>
            </div>
            <div class="mt-2 pt-2 border-t border-gray-100 text-gray-400 text-[13px] flex justify-between">
              <span>已完成任务 <span data-test="done-count" class="text-brand-600 font-semibold">{{ doneCount[e.id] ?? 0 }}</span> 单</span>
              <span>›</span>
            </div>
          </el-card>
        </el-col>
      </el-row>
    </div>
  </section>
</template>
