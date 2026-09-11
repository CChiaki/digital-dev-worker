<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type CapabilityDef, type TaskSummary } from '../api.js';
import { nextPlanId, pkgToYaml, planFormToYaml, yamlToPlanForm, type PlanFormRow, type TaskFormState } from '../task-form.js';

const props = defineProps<{ modelValue: boolean; editTaskId?: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; created: [taskId: string] }>();

type Mode = 'form' | 'yaml' | 'ai';
const mode = ref<Mode>('form');

/** 编辑模式（2026-09-06 draft 修改）：传入 editTaskId 即为编辑既有草稿，yaml 回填可改可保存 */
const isEdit = computed(() => !!props.editTaskId);

const submitting = ref(false);
const error = ref('');
const yamlText = ref('');
const capabilities = ref<CapabilityDef[]>([]);
// 下拉化数据源（2026-09-07 岗位即分类）：岗位（role 选项，来自岗位管理清单）、已有任务（dependsOn 选项）
const taskOptions = ref<TaskSummary[]>([]);
// 智能生成（终审 G1，2026-09-06）：自然语言描述 → 后端解析为任务包 yaml
const aiDescription = ref('');
const generating = ref(false);

const emptyForm = (): TaskFormState => ({
  taskId: '', title: '', role: '',
  repoUrl: '', branch: '',
  dependsOn: [],
  plan: [newRow('t1')],
});
const form = ref<TaskFormState>(emptyForm());

function newRow(id: string): PlanFormRow {
  return { id, kind: '', title: '', detail: '', verify: '' };
}

/** kind 下拉选项：已启用能力 + 空选项「(缺省 dev)」 */
const kindOptions = () => capabilities.value.filter((c) => c.enabled);

// 岗位下拉选项（2026-09-07 岗位即分类）：来自岗位管理清单（分类表 name），受管不可自由创建
// （2026-09-06 分派分离：创建表单不再有「指定员工」下拉，分派移至任务列表页）
const roleOptions = ref<string[]>([]);
// dependsOn 下拉选项：已有任务（taskId + 标题），排除自身（自依赖无意义）；比较做 trim（台账 T5②）
const depOptions = computed(() =>
  taskOptions.value
    .filter((t) => t.taskId.trim() !== form.value.taskId.trim())
    .map((t) => ({ value: t.taskId, label: `${t.taskId} ${t.title}` })),
);

// 防自依赖（终审 I-1）：depOptions 只过滤选项列表不过滤已选值——用户先选依赖再改 taskId
// 为该依赖时 form.dependsOn 会残留自身，发布后 readinessOf 永久 waiting。taskId 变化时剔除等于当前 id（trim 比较）的已选项
watch(
  () => form.value.taskId,
  (taskId) => {
    const id = taskId.trim();
    if (id && form.value.dependsOn?.some((d) => d.trim() === id)) {
      form.value.dependsOn = form.value.dependsOn.filter((d) => d.trim() !== id);
    }
  },
);

// 测试可见：kind 选项的 enabled 过滤逻辑
defineExpose({ kindOptions });

// 每次打开重置状态并拉取能力注册表（kind 下拉数据源）；immediate：初次以打开态挂载时同样生效。
// 编辑模式：yaml 模式起步（pkgToYaml 全量回填零损失），用户可「从 yaml 反填」切表单
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    // 新建默认智能生成 tab（2026-09-10 用户需求：AI 生成是主入口）；编辑模式仍 yaml 起步（全量回填零损失）
    mode.value = isEdit.value ? 'yaml' : 'ai';
    error.value = '';
    yamlText.value = '';
    aiDescription.value = '';
    form.value = emptyForm();
    try {
      capabilities.value = await api.listCapabilities();
    } catch {
      capabilities.value = []; // 能力接口不可用不阻塞创建，kind 下拉退化为仅空选项
    }
    // 岗位/dependsOn 数据源：拉取失败不阻塞对话框（岗位可不选 = 不限、依赖可不选）；
    // 兜底非数组形状（接口异常返回 undefined 时不得炸 map/filter）
    try {
      const [ts, cats] = await Promise.all([api.listTasks(), api.listSkillCategories()]);
      taskOptions.value = Array.isArray(ts) ? ts : [];
      roleOptions.value = Array.isArray(cats) ? cats.map((c) => c.name) : [];
    } catch {
      taskOptions.value = [];
      roleOptions.value = []; // 岗位清单拉取失败保持空数组（受管不可手输，可留空 = 不限）
    }
    // 编辑回填：拉任务详情 → pkg 转 yaml 填入（含 plan/tasks/dependsOn 等全量字段）
    if (props.editTaskId) {
      try {
        const record = await api.getTask(props.editTaskId);
        yamlText.value = pkgToYaml(record.pkg);
      } catch (e) {
        error.value = `任务详情获取失败：${e instanceof Error ? e.message : String(e)}`;
      }
    }
  },
  { immediate: true },
);

function addRow(): void {
  form.value.plan.push(newRow(nextPlanId(form.value.plan.map((r) => r.id))));
}
function removeRow(idx: number): void {
  form.value.plan.splice(idx, 1);
}
function moveRow(idx: number, delta: -1 | 1): void {
  const target = idx + delta;
  if (target < 0 || target >= form.value.plan.length) return;
  const [row] = form.value.plan.splice(idx, 1);
  form.value.plan.splice(target, 0, row!);
}

/** 表单 → yaml 预览（2026-09-06 用户偏好）：切到 yaml 直贴 tab 展示（可编辑后直接保存），不再页内只读展示 */
function previewYaml(): void {
  yamlText.value = planFormToYaml(form.value);
  mode.value = 'yaml';
}

/** yaml 直贴 → 表单反填（切到表单模式继续编辑）；老包字段防丢：需用户确认才切 */
async function fillFromYaml(): Promise<void> {
  error.value = '';
  let next: TaskFormState;
  try {
    next = yamlToPlanForm(yamlText.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
  if (next.legacyFields?.length) {
    try {
      await ElMessageBox.confirm(
        `该 yaml 含计划模式不支持的字段（${next.legacyFields.join('、')}），切到表单模式提交会丢失这些字段，建议留在 yaml 模式提交。确定仍要切到表单模式？`,
        '可能丢失老包字段',
        { type: 'warning', confirmButtonText: '仍切表单模式', cancelButtonText: '留在 yaml 模式' },
      );
    } catch {
      return; // 用户取消：不切换、留在 yaml 模式（提交走原文，零损失）
    }
  }
  form.value = next;
  mode.value = 'form';
}

/** 智能生成（终审 G1，spec §2.1 第三模式）：自然语言描述 → 后端解析为任务包 yaml，切 yaml 模式预填供检查/修改后确认添加 */
async function generateFromDescription(): Promise<void> {
  if (generating.value) return; // 防重复点击（loading 之外的双保险）
  if (!aiDescription.value.trim()) {
    ElMessage.warning('请先输入自然语言需求描述');
    return;
  }
  generating.value = true;
  try {
    const res = await api.parseTask(aiDescription.value);
    yamlText.value = res.yaml;
    mode.value = 'yaml'; // 预填展示：用户检查/修改后点确认添加（走 createTask，默认 draft）
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e)); // 后端 400 可读文案原样透出
  } finally {
    generating.value = false;
  }
}

async function submit(): Promise<void> {
  const yaml = mode.value === 'form' ? planFormToYaml(form.value) : yamlText.value;
  if (!yaml.trim()) return;
  submitting.value = true;
  error.value = '';
  try {
    const res = await api.createTask(yaml);
    // 编辑语义按返回状态区分（2026-09-10）：终态（failed/done）重提 = 重跑直接回待分派；
    // draft/pending 覆盖回草稿需重新发布
    ElMessage.success(isEdit.value
      ? (res.status === 'pending'
        ? `任务 ${res.taskId} 已更新（恢复待分派，将重新调度执行）`
        : `任务 ${res.taskId} 已更新（回到草稿，需重新发布）`)
      : `任务 ${res.taskId} 已入库`);
    emit('created', res.taskId);
    emit('update:modelValue', false);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e); // 后端 400 message 原样展示
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    :title="isEdit ? `编辑任务 · ${props.editTaskId}` : '新建任务'"
    :data-test="isEdit ? 'task-dialog-edit' : 'task-dialog-create'"
    width="80%"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <el-radio-group v-model="mode" class="mb-3.5">
      <el-radio-button data-test="mode-ai" value="ai">智能生成</el-radio-button>
      <el-radio-button data-test="mode-form" value="form">表单配置</el-radio-button>
      <el-radio-button data-test="mode-yaml" value="yaml">yaml 直贴</el-radio-button>
    </el-radio-group>

    <!-- 表单配置模式 -->
    <template v-if="mode === 'form'">
      <el-form label-width="120px">
        <el-row :gutter="12">
          <el-col :span="12"><el-form-item label="任务 ID"><el-input data-test="f-task-id" v-model="form.taskId" placeholder="feat-login" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="标题"><el-input data-test="f-title" v-model="form.title" placeholder="登录功能开发" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="仓库地址"><el-input data-test="f-repo-url" v-model="form.repoUrl" placeholder="http://gitlab.inner.bank/x.git" /></el-form-item></el-col>
          <el-col :span="6"><el-form-item label="工作分支"><el-input data-test="f-branch" v-model="form.branch" placeholder="develop" /></el-form-item></el-col>
          <el-col :span="6"><el-form-item label="岗位">
            <el-select
              data-test="f-role" v-model="form.role" filterable clearable
              placeholder="选择岗位（可空 = 不限）" :teleported="false"
            >
              <el-option v-for="r in roleOptions" :key="r" :label="r" :value="r" :data-test="`role-option-${r}`" />
            </el-select>
          </el-form-item></el-col>
          <el-col :span="24"><el-form-item label="依赖任务">
            <el-select
              data-test="f-depends-on" v-model="form.dependsOn" multiple collapse-tags clearable
              placeholder="选择前置任务（可空）" :teleported="false" class="!w-full"
            >
              <el-option v-for="o in depOptions" :key="o.value" :label="o.label" :value="o.value" :data-test="`dep-option-${o.value}`" />
            </el-select>
          </el-form-item></el-col>
        </el-row>
      </el-form>

      <!-- 标题行右置添加按钮（2026-09-06 用户偏好） -->
      <div class="mt-1 mb-2 flex items-center justify-between">
        <p class="text-[13px] text-gray-600">计划项（逐项执行，kind 缺省 dev）：</p>
        <el-button data-test="add-row" @click="addRow">+ 添加计划项</el-button>
      </div>
      <el-table :data="form.plan" data-test="plan-table">
        <el-table-column label="#" width="44">
          <template #default="scope">{{ scope.$index + 1 }}</template>
        </el-table-column>
        <el-table-column label="项 ID" width="100">
          <template #default="scope"><el-input v-model="scope.row.id" placeholder="t1" /></template>
        </el-table-column>
        <el-table-column label="kind" width="160">
          <template #default="scope">
            <el-select v-model="scope.row.kind" placeholder="(缺省 dev)" clearable :teleported="false" data-test="kind-select">
              <el-option label="(缺省 dev)" value="" data-test="kind-option-empty" />
              <el-option
                v-for="c in kindOptions()"
                :key="c.kind"
                :label="c.name"
                :value="c.kind"
                :data-test="`kind-option-${c.kind}`"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="标题" min-width="140">
          <template #default="scope"><el-input v-model="scope.row.title" placeholder="开发登录接口" /></template>
        </el-table-column>
        <el-table-column label="要求" min-width="160">
          <template #default="scope"><el-input v-model="scope.row.detail" placeholder="实现 POST /api/login" /></template>
        </el-table-column>
        <el-table-column label="验证" min-width="120">
          <template #default="scope"><el-input v-model="scope.row.verify" placeholder="npm run build（可空）" /></template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="scope">
            <el-button link type="default" :disabled="scope.$index === 0" @click="moveRow(scope.$index, -1)">上移</el-button>
            <el-button link type="default" :disabled="scope.$index === form.plan.length - 1" @click="moveRow(scope.$index, 1)">下移</el-button>
            <el-button link type="danger" @click="removeRow(scope.$index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <!-- 智能生成模式（终审 G1，spec §2.1 第三模式）：自然语言描述 → AI 解析为任务包 yaml -->
    <template v-else-if="mode === 'ai'">
      <el-input
        data-test="ai-description"
        v-model="aiDescription"
        type="textarea"
        :rows="6"
        placeholder="用自然语言描述需求，例如：仓库：xxxx,分支：xxxx,我需要开发/修复/验证xxxx功能，然后发布/部署/构建等，尽量包含完整的任务链，AI获取解析拆分你的任务"
      />
    </template>

    <!-- yaml 直贴模式（老创建入口迁入，行为等价；智能生成成功后也切到此模式预填） -->
    <template v-else>
      <el-input
        data-test="yaml-input"
        v-model="yamlText"
        type="textarea"
        :rows="10"
        placeholder="taskId: TASK-2026-...&#10;title: ...&#10;repo: ..."
      />
      <div class="mt-2.5 flex gap-2">
        <el-button data-test="fill-from-yaml" @click="fillFromYaml">从 yaml 反填</el-button>
      </div>
    </template>

    <el-alert v-if="error" data-test="error" :title="error" type="error" :closable="false" show-icon class="mt-2.5" />

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <!-- 动作按钮统一放 footer 取消旁（2026-09-06 用户偏好）：表单=生成 yaml 预览 / 智能=AI 生成 / yaml=保存任务 -->
      <el-button v-if="mode === 'form'" data-test="preview-yaml" type="primary" @click="previewYaml">生成 yaml 预览</el-button>
      <el-button v-else-if="mode === 'ai'" data-test="ai-generate" type="primary" :loading="generating" @click="generateFromDescription">
        {{ generating ? '生成中…' : 'AI 生成' }}
      </el-button>
      <el-button v-else data-test="submit" type="primary" :loading="submitting" @click="submit">
        {{ submitting ? '保存中…' : '保存任务' }}
      </el-button>
    </template>
  </el-dialog>
</template>
