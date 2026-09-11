<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type EmployeeRecordView } from '../api.js';
import { zh, SUPERVISION_ZH } from '../status.js';
import EmployeeEditDialog from '../components/EmployeeEditDialog.vue';

// 数字员工管理页（2026-09-06 后台化）：替代旧 EmployeeRoster 只读视图（busy/runningTasks 列保留）
const router = useRouter();

const employees = ref<EmployeeRecordView[]>([]);
const loading = ref(false);
const error = ref('');
let timer: ReturnType<typeof setInterval> | undefined;

const dialogVisible = ref(false);
const editing = ref<EmployeeRecordView | null>(null); // null = 新增

/** 检索区（2026-09-06 列表页风格统一）：姓名/岗位关键词过滤（大小写不敏感） */
const keyword = ref('');
const matches = (e: EmployeeRecordView): boolean => {
  const k = keyword.value.trim().toLowerCase();
  return !k || e.name.toLowerCase().includes(k) || (e.roles ?? []).some((r) => r.toLowerCase().includes(k));
};
const filtered = computed(() => employees.value.filter(matches));
defineExpose({ matches });

async function load() {
  loading.value = true;
  error.value = '';
  try {
    employees.value = await api.listEmployees();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  dialogVisible.value = true;
}

function openEdit(row: EmployeeRecordView) {
  editing.value = row;
  dialogVisible.value = true;
}

/** 启停开关：停用走 confirm（历史任务保留）；启用直接 PUT 整行提交（model 含脱敏 '***' = 保原 key） */
async function toggleEnabled(row: EmployeeRecordView, enabled: boolean) {
  if (!enabled) {
    try {
      await ElMessageBox.confirm(`确认停用该员工 ${row.name}（${row.id}）？（历史任务保留）`, '停用员工', {
        type: 'warning',
        confirmButtonText: '停用',
        cancelButtonText: '取消',
      });
    } catch {
      return; // 取消：不动作（switch 由刷新列表复位）
    }
    try {
      await api.disableEmployee(row.id);
      ElMessage.success(`员工 ${row.id} 已停用`);
    } catch (e) {
      ElMessage.error(e instanceof Error ? e.message : String(e));
    }
  } else {
    try {
      await api.updateEmployee(row.id, {
        id: row.id,
        name: row.name,
        roles: [...(row.roles ?? [])], // 启用整行提交：载荷对齐多岗位 roles（2026-09-07）
        capabilities: row.capabilities,
        supervision: row.supervision,
        enabled: true,
        ...(row.model ? { model: { ...row.model } } : {}),
      });
      ElMessage.success(`员工 ${row.id} 已启用`);
    } catch (e) {
      ElMessage.error(e instanceof Error ? e.message : String(e));
    }
  }
  await load();
}

onMounted(() => {
  void load();
  timer = setInterval(load, 5000); // 名册轮询：忙闲随任务状态刷新
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <section class="view">
    <h2>数字员工</h2>

    <div class="flex items-center gap-3 mb-4">
      <el-input v-model="keyword" data-test="employees-search" placeholder="按姓名/岗位检索" clearable class="!w-64" />
      <el-alert v-if="error" data-test="error" :title="error" type="error" :closable="false" show-icon class="flex-1" />
      <el-button data-test="create-btn" type="primary" class="ml-auto" @click="openCreate">新增员工</el-button>
    </div>

    <EmployeeEditDialog v-model="dialogVisible" :employee="editing" @saved="load" />

    <p v-if="loading && employees.length === 0" class="text-gray-400">加载中…</p>
    <el-empty v-else-if="employees.length === 0" description="暂无员工档案。点击「新增员工」登记第一位数字员工。" />

    <el-card v-else shadow="never">
      <el-table :data="filtered" data-test="emp-table" @row-click="(row: EmployeeRecordView) => router.push(`/employees/${row.id}`)">
        <el-table-column prop="id" label="ID" width="130">
          <template #default="scope"><code>{{ scope.row.id }}</code></template>
        </el-table-column>
        <el-table-column prop="name" label="姓名" width="100" />
        <el-table-column label="岗位" min-width="140">
          <template #default="scope">
            <!-- 多岗位 tags（2026-09-07）：写法对齐能力绑定列 -->
            <el-tag v-for="r in scope.row.roles ?? []" :key="r" class="mr-1.5">{{ r }}</el-tag>
            <span v-if="!(scope.row.roles ?? []).length" class="text-gray-400">—</span>
          </template>
        </el-table-column>
        <el-table-column label="能力绑定" min-width="150">
          <template #default="scope">
            <el-tag v-for="c in scope.row.capabilities ?? []" :key="c" type="warning" class="mr-1.5">{{ c }}</el-tag>
            <span v-if="!(scope.row.capabilities ?? []).length" class="text-gray-400">全部</span>
          </template>
        </el-table-column>
        <el-table-column label="盯梢等级" width="100">
          <template #default="scope">{{ zh(SUPERVISION_ZH, scope.row.supervision) }}</template>
        </el-table-column>
        <el-table-column label="忙闲" width="130">
          <template #default="scope">
            <el-tag data-test="busy" :type="scope.row.busy ? 'primary' : 'info'">
              {{ scope.row.busy ? '执行中' : '空闲' }}
            </el-tag>
            <div v-if="scope.row.runningTasks.length" data-test="running-tasks" class="text-gray-400 text-xs mt-0.5">{{ scope.row.runningTasks.join('、') }}</div>
          </template>
        </el-table-column>
        <el-table-column label="启停" width="80">
          <template #default="scope">
            <!-- 外包一层 .stop：el-switch 根节点 click 只 prevent 不 stop，会冒泡到 tr 触发 @row-click 误导航 -->
            <span class="switch-cell" @click.stop>
              <el-switch
                :model-value="scope.row.enabled"
                :data-test="`enable-switch-${scope.row.id}`"
                @change="(v: boolean) => toggleEnabled(scope.row, v)"
              />
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80">
          <template #default="scope">
            <el-button data-test="edit-btn" link type="primary" @click.stop="openEdit(scope.row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p v-if="filtered.length === 0" data-test="empty-filter" class="text-center text-gray-400 py-10">无匹配员工</p>
    </el-card>

    <!-- 已停用员工仍可见（历史任务 claimedBy 引用不断），但置灰标识 -->
    <p class="text-gray-400 mt-2.5 text-xs">点击行进入员工详情；停用员工不再接新任务，历史任务保留。</p>
  </section>
</template>

<style scoped>
/* EP 表格行内部结构：Tailwind 无法直达，保留 :deep 覆写 */
:deep(.el-table__row) { cursor: pointer; }
</style>
