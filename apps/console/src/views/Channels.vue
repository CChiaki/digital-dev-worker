<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type NotificationChannelView } from '../api.js';

/** 渠道类型展示（与后端 NotificationChannelDef 对齐：dingtalk | wecom | webhook | yanxun） */
const TYPE_LABEL: Record<NotificationChannelView['type'], string> = { dingtalk: '钉钉', wecom: '企微', webhook: 'Webhook', yanxun: '燕讯' };
const TYPE_TAG: Record<NotificationChannelView['type'], 'primary' | 'success' | 'info' | 'warning'> = { dingtalk: 'primary', wecom: 'success', webhook: 'info', yanxun: 'warning' };
const TYPE_OPTIONS: NotificationChannelView['type'][] = ['dingtalk', 'wecom', 'webhook', 'yanxun'];

const channels = ref<NotificationChannelView[]>([]);
const loading = ref(false);
const error = ref('');

const dialogVisible = ref(false);
const editingId = ref(''); // 非空 = 编辑该渠道（id 只读）
const saving = ref(false);
const draft = ref<NotificationChannelView>(emptyDraft());
const testingId = ref(''); // 正在发测试消息的渠道（按钮 loading）

/** 检索区（2026-09-06 列表页风格统一）：名称关键词过滤（大小写不敏感） */
const keyword = ref('');
const matches = (c: NotificationChannelView): boolean => {
  const k = keyword.value.trim().toLowerCase();
  return !k || c.name.toLowerCase().includes(k);
};
const filtered = computed(() => channels.value.filter(matches));
defineExpose({ matches });

function emptyDraft(): NotificationChannelView {
  return { id: '', type: 'dingtalk', name: '', webhookUrl: '', secret: '', token: '', enabled: true };
}

/** URL 脱敏：仅显示 host + ***（token/key 不外泄到页面） */
function maskUrl(url: string): string {
  try {
    return `${new URL(url).host}/***`;
  } catch {
    return '***';
  }
}

/** 燕讯 access_token 脱敏：仅显示前 8 位 + ***（回显 '***' 时编辑不重填即保留原值） */
function maskToken(token: string): string {
  return token ? `${token.slice(0, 8)}***` : '';
}

/** 列表展示值：燕讯展示脱敏 token，其余展示脱敏 webhook host */
function maskedTarget(c: NotificationChannelView): string {
  return c.type === 'yanxun' ? maskToken(c.token ?? '') : maskUrl(c.webhookUrl);
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    channels.value = await api.listChannels();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function newId(): string {
  return `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function openCreate() {
  editingId.value = '';
  draft.value = emptyDraft();
  dialogVisible.value = true;
}

function openEdit(row: NotificationChannelView) {
  editingId.value = row.id;
  draft.value = { ...row, secret: row.secret ?? '', token: row.token ?? '' };
  dialogVisible.value = true;
}

async function save() {
  saving.value = true;
  try {
    // 按类型归一：燕讯不带 webhookUrl/secret，其余类型不带 token（避免换类型后残留脏字段）
    const def: NotificationChannelView = { ...draft.value, id: editingId.value || newId() };
    if (def.type === 'yanxun') {
      def.webhookUrl = '';
      delete def.secret;
    } else {
      delete def.token;
    }
    if (editingId.value) {
      await api.updateChannel(editingId.value, def);
      ElMessage.success(`渠道 ${def.name} 已更新`);
    } else {
      await api.createChannel(def);
      ElMessage.success(`渠道 ${def.name} 已登记`);
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
async function toggleEnabled(row: NotificationChannelView, enabled: boolean) {
  const prev = row.enabled;
  row.enabled = enabled; // switch 先行，失败回滚
  try {
    await api.updateChannel(row.id, { ...row, enabled });
    ElMessage.success(`渠道 ${row.name} 已${enabled ? '启用' : '停用'}`);
  } catch (e) {
    row.enabled = prev;
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

/** 发送测试消息：502（渠道不可达）等错误原样 ElMessage.error */
async function sendTest(row: NotificationChannelView) {
  testingId.value = row.id;
  try {
    await api.testChannel(row.id);
    ElMessage.success(`测试消息已发送到「${row.name}」，请在群里确认`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    testingId.value = '';
  }
}

async function remove(row: NotificationChannelView) {
  try {
    await ElMessageBox.confirm(`确认删除渠道 ${row.name}（${TYPE_LABEL[row.type]}）？删除后任务通知不再推送到它。`, '删除渠道', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return; // 取消
  }
  try {
    await api.deleteChannel(row.id);
    ElMessage.success(`渠道 ${row.name} 已删除`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e)); // 404「渠道不存在」原样展示
  }
}

onMounted(load);
</script>

<template>
  <section class="view">
    <h2>通知渠道 <span class="ml-3 text-sm font-normal text-gray-400">任务待放行 / 失败 / 完成推送到群机器人</span></h2>

    <div class="flex items-center gap-3 mb-4">
      <el-input v-model="keyword" data-test="channels-search" placeholder="按名称检索" clearable class="!w-64" />
      <el-alert v-if="error" data-test="error" :title="error" type="error" :closable="false" show-icon class="flex-1" />
      <el-button data-test="create-btn" type="primary" class="ml-auto" @click="openCreate">新增渠道</el-button>
    </div>

    <el-card shadow="never">

      <p v-if="loading && channels.length === 0" class="text-gray-400">加载中…</p>
      <el-empty v-else-if="channels.length === 0" description="暂无通知渠道" />

      <template v-else>
      <el-table :data="filtered" data-test="channel-table">
        <el-table-column label="类型" width="110">
          <template #default="scope">
            <el-tag :data-test="`type-tag-${scope.row.id}`" :type="TYPE_TAG[scope.row.type as keyof typeof TYPE_TAG]">
              {{ TYPE_LABEL[scope.row.type as keyof typeof TYPE_LABEL] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="名称" width="150" show-overflow-tooltip />
        <el-table-column label="地址 / Token" min-width="220">
          <template #default="scope">
            <code :data-test="`masked-url-${scope.row.id}`">{{ maskedTarget(scope.row) }}</code>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="90">
          <template #default="scope">
            <el-switch
              :model-value="scope.row.enabled"
              :data-test="`enable-switch-${scope.row.id}`"
              @change="(v: boolean) => toggleEnabled(scope.row, v)"
            />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210">
          <template #default="scope">
            <el-button
              :data-test="`test-btn-${scope.row.id}`"
              link
              type="primary"
              :loading="testingId === scope.row.id"
              @click="sendTest(scope.row)"
            >发送测试</el-button>
            <el-button data-test="edit-btn" link type="primary" @click="openEdit(scope.row)">编辑</el-button>
            <el-button data-test="delete-btn" link type="danger" @click="remove(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p v-if="filtered.length === 0" data-test="empty-filter" class="text-center text-gray-400 py-10">无匹配渠道</p>
      </template>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? `编辑渠道 · ${draft.name}` : '新增渠道'" width="80%">
      <el-form label-width="120px">
        <el-form-item label="类型">
          <el-select data-test="d-type" v-model="draft.type" :teleported="false" style="width: 100%">
            <el-option v-for="t in TYPE_OPTIONS" :key="t" :label="TYPE_LABEL[t]" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="名称">
          <el-input data-test="d-name" v-model="draft.name" placeholder="值班群 / 项目群 ..." />
        </el-form-item>
        <el-form-item v-if="draft.type === 'yanxun'" label="access_token">
          <el-input
            data-test="d-token"
            v-model="draft.token"
            type="textarea"
            :rows="2"
            placeholder="机器人 access_token（sendRobotTex 的 requestBody.token）"
          />
        </el-form-item>
        <el-form-item v-else label="Webhook URL">
          <el-input data-test="d-url" v-model="draft.webhookUrl" type="textarea" :rows="2" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
        </el-form-item>
        <el-form-item v-if="draft.type === 'dingtalk'" label="加签 secret">
          <el-input data-test="d-secret" v-model="draft.secret" placeholder="SEC...（钉钉机器人加签密钥，可空）" />
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
