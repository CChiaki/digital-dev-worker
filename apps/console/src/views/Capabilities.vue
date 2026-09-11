<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type CapabilityDef, type McpServerStatus } from '../api.js';

const capabilities = ref<CapabilityDef[]>([]);
const loading = ref(false);
const error = ref('');

/**
 * 工具来源选项（2026-09-06 用户需求 A 服务端化）：从 /api/capabilities/meta 拉取，
 * mcp 含内置包 + 已注册 MCP server 名（yaml 注册即展示）；拉取失败回退内置常量
 */
const BUILTIN_TOOLS = ref(['bash', 'files']);
const MCP_PACKS = ref(['forge', 'deploy']);
/** MCP server 状态清单（2026-09-06 用户需求 B）：连接状态 + 已发现工具数展示 */
const mcpServers = ref<McpServerStatus[]>([]);

const dialogVisible = ref(false);
const editingKind = ref(''); // 非空 = 编辑该能力（kind 只读）
const saving = ref(false);
const draft = ref<CapabilityDef>(emptyDraft());

/** 检索区（2026-09-06 列表页风格统一）：kind/说明关键词过滤（大小写不敏感） */
const keyword = ref('');
const matches = (c: CapabilityDef): boolean => {
  const k = keyword.value.trim().toLowerCase();
  return !k || c.kind.toLowerCase().includes(k) || (c.description ?? '').toLowerCase().includes(k);
};
const filtered = computed(() => capabilities.value.filter(matches));
defineExpose({ matches });

function emptyDraft(): CapabilityDef {
  return { kind: '', name: '', description: '', tools: { builtin: [], mcp: [] }, enabled: true };
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    // meta 与 mcp-servers 拉取失败不阻塞主表（回退常量/空清单）
    try {
      const meta = await api.capabilityMeta();
      if (Array.isArray(meta.builtin) && meta.builtin.length) BUILTIN_TOOLS.value = meta.builtin;
      if (Array.isArray(meta.mcp)) MCP_PACKS.value = meta.mcp;
      mcpServers.value = await api.listMcpServers();
    } catch { /* 保持缺省 */ }
    capabilities.value = await api.listCapabilities();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editingKind.value = '';
  draft.value = emptyDraft();
  dialogVisible.value = true;
}

function openEdit(row: CapabilityDef) {
  editingKind.value = row.kind;
  draft.value = { ...row, tools: { builtin: [...row.tools.builtin], mcp: [...row.tools.mcp] } };
  dialogVisible.value = true;
}

async function save() {
  saving.value = true;
  try {
    if (editingKind.value) {
      await api.updateCapability(editingKind.value, draft.value);
      ElMessage.success(`能力 ${draft.value.kind} 已更新`);
    } else {
      await api.createCapability(draft.value);
      ElMessage.success(`能力 ${draft.value.kind} 已登记`);
    }
    dialogVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e)); // 后端 400 message 原样展示
  } finally {
    saving.value = false;
  }
}

/** 启停开关：整行 upsert（switch change 即生效） */
async function toggleEnabled(row: CapabilityDef, enabled: boolean) {
  const prev = row.enabled;
  row.enabled = enabled; // switch 先行，失败回滚
  try {
    await api.updateCapability(row.kind, { ...row, enabled });
    ElMessage.success(`能力 ${row.kind} 已${enabled ? '启用' : '停用'}`);
  } catch (e) {
    row.enabled = prev;
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function remove(row: CapabilityDef) {
  try {
    await ElMessageBox.confirm(`确认删除能力 ${row.kind}（${row.name}）？已引用它的任务计划将无法固化。`, '删除能力', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return; // 取消
  }
  try {
    await api.deleteCapability(row.kind);
    ElMessage.success(`能力 ${row.kind} 已删除`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e)); // 404「能力不存在」原样展示
  }
}

onMounted(load);
</script>

<template>
  <section class="view">
    <h2>能力管理 <span class="ml-3 text-sm font-normal text-gray-400">任务项 kind → 工具集映射</span></h2>

    <div class="flex items-center gap-3 mb-4">
      <el-input v-model="keyword" data-test="capabilities-search" placeholder="按 kind/说明检索" clearable class="!w-64" />
      <el-alert v-if="error" data-test="error" :title="error" type="error" :closable="false" show-icon class="flex-1" />
      <el-button data-test="create-btn" type="primary" class="ml-auto" @click="openCreate">新增能力</el-button>
    </div>

    <!-- MCP server 状态（2026-09-06 用户需求 B）：runtime yaml mcpServers 注册即在此展示 -->
    <el-card v-if="mcpServers.length" shadow="never" class="mb-4" data-test="mcp-servers">
      <template #header><strong>MCP 服务</strong> <span class="text-sm text-gray-400">runtime 配置注册，连接后自动可被能力引用</span></template>
      <div class="flex flex-wrap gap-3">
        <div
          v-for="s in mcpServers"
          :key="s.name"
          :data-test="`mcp-server-${s.name}`"
          class="border rounded px-3 py-2 min-w-52"
        >
          <div class="flex items-center gap-2">
            <code>{{ s.name }}</code>
            <el-tag :type="s.status === 'connected' ? 'success' : 'danger'" size="small">
              {{ s.status === 'connected' ? '已连接' : '连接失败' }}
            </el-tag>
          </div>
          <p class="text-[13px] text-gray-500 mt-1">
            {{ s.status === 'connected' ? `${s.tools.length} 个工具` : (s.error ?? '未知错误') }}
          </p>
        </div>
      </div>
    </el-card>

    <el-card shadow="never">

      <p v-if="loading && capabilities.length === 0" class="text-gray-400">加载中…</p>
      <el-empty v-else-if="capabilities.length === 0" description="暂无能力登记" />

      <template v-else>
      <el-table :data="filtered" data-test="cap-table">
        <el-table-column prop="kind" label="kind" width="110">
          <template #default="scope"><code>{{ scope.row.kind }}</code></template>
        </el-table-column>
        <el-table-column prop="name" label="名称" width="130" />
        <el-table-column prop="description" label="说明" min-width="220" show-overflow-tooltip />
        <el-table-column label="工具来源" min-width="220">
          <template #default="scope">
            <el-tag
              v-for="t in scope.row.tools.builtin"
              :key="t"
              class="mr-1.5 font-mono"
              :data-test="`builtin-tag-${scope.row.kind}-${t}`"
            >{{ t }}</el-tag>
            <el-tag
              v-for="t in scope.row.tools.mcp"
              :key="t"
              type="warning"
              class="mr-1.5 font-mono"
              :data-test="`mcp-tag-${scope.row.kind}-${t}`"
            >mcp:{{ t }}</el-tag>
            <span v-if="!scope.row.tools.builtin.length && !scope.row.tools.mcp.length" class="text-gray-400">无工具</span>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="90">
          <template #default="scope">
            <el-switch
              :model-value="scope.row.enabled"
              :data-test="`enable-switch-${scope.row.kind}`"
              @change="(v: boolean) => toggleEnabled(scope.row, v)"
            />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130">
          <template #default="scope">
            <el-button data-test="edit-btn" link type="primary" @click="openEdit(scope.row)">编辑</el-button>
            <el-button data-test="delete-btn" link type="danger" @click="remove(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p v-if="filtered.length === 0" data-test="empty-filter" class="text-center text-gray-400 py-10">无匹配能力</p>
      </template>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingKind ? `编辑能力 · ${editingKind}` : '新增能力'" width="80%">
      <el-form label-width="120px">
        <el-form-item label="kind">
          <el-input data-test="d-kind" v-model="draft.kind" :disabled="!!editingKind" placeholder="dev / test / commit ..." />
        </el-form-item>
        <el-form-item label="名称">
          <el-input data-test="d-name" v-model="draft.name" placeholder="开发编码" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input data-test="d-description" v-model="draft.description" type="textarea" :rows="2" placeholder="该类任务项允许做什么（可空）" />
        </el-form-item>
        <el-form-item label="内置工具">
          <el-checkbox-group data-test="d-builtin" v-model="draft.tools.builtin">
            <el-checkbox v-for="t in BUILTIN_TOOLS" :key="t" :value="t">{{ t }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="MCP 工具包">
          <el-checkbox-group data-test="d-mcp" v-model="draft.tools.mcp">
            <el-checkbox v-for="t in MCP_PACKS" :key="t" :value="t">{{ t }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch data-test="d-enabled" v-model="draft.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button data-test="save-btn" type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>
