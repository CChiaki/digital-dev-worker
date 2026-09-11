<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { api, type CapabilityDef, type EmployeeRecordView, type SkillCategoryView } from '../api.js';
import { zh, SUPERVISION_ZH } from '../status.js';

/** 新增/编辑共用对话框（2026-09-06 员工管理后台化）：Employees 与 EmployeeDetail 两页复用 */
const props = defineProps<{ modelValue: boolean; employee?: EmployeeRecordView | null }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: [] }>();

type EmployeeDraft = Omit<EmployeeRecordView, 'busy' | 'runningTasks'>;

const isEdit = computed(() => !!props.employee);
const hasBinding = computed(() => !!props.employee?.model); // 编辑已有绑定：apiKey 留空 = 保原 key

const saving = ref(false);
const capabilities = ref<CapabilityDef[]>([]);
// 岗位清单（分类表，2026-09-07 岗位即分类）：岗位下拉数据源，选项文本/值均为分类名
const roleOptions = ref<SkillCategoryView[]>([]);

const form = ref<EmployeeDraft>(emptyDraft());
const formRef = ref<FormInstance>(); // 主表单引用：保存前校验（2026-09-07 T5 评审：至少选一岗）
// 主表单校验规则（2026-09-07 员工多岗位评审补）：岗位至少选一，空数组不得保存
const rules: FormRules = {
  roles: [
    {
      validator: (_rule, value: string[] | undefined, callback) => {
        if (Array.isArray(value) && value.length > 0) callback();
        else callback(new Error('至少选择一个岗位'));
      },
      trigger: 'change',
    },
  ],
};
const bindModel = ref(false); // 绑定专属模型开关：关 = 用全局模型（提交 model 置 undefined）
const modelForm = ref({ api: 'openai-completions' as 'openai-completions' | 'anthropic-messages', baseUrl: '', model: '', apiKey: '' });

function emptyDraft(): EmployeeDraft {
  return { id: '', name: '', roles: [], capabilities: [], supervision: 'shadow', enabled: true };
}

// 盯梢等级下拉选项（中文映射复用 status.ts 由模板完成）
const SUPERVISION_OPTIONS = ['shadow', 'assisted', 'trusted'] as const;

// 每次打开重置并拉取能力注册表（能力绑定下拉数据源；失败不阻塞，绑定为空 = 全部可用）
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    form.value = props.employee
      ? {
          id: props.employee.id,
          name: props.employee.name,
          roles: [...(props.employee.roles ?? [])], // 多岗位数组拷贝（2026-09-07）
          capabilities: [...(props.employee.capabilities ?? [])],
          supervision: props.employee.supervision,
          enabled: props.employee.enabled,
        }
      : emptyDraft();
    bindModel.value = !!props.employee?.model;
    // apiKey 不回显（GET 已脱敏为 '***'）；留空提交 = 后端保原 key
    modelForm.value = props.employee?.model
      ? {
          api: props.employee.model.api ?? 'openai-completions',
          baseUrl: props.employee.model.baseUrl,
          model: props.employee.model.model,
          apiKey: '',
        }
      : { api: 'openai-completions', baseUrl: '', model: '', apiKey: '' };
    try {
      // 能力注册表与岗位清单并行拉取（岗位清单失败不阻塞：roleOptions 空 = 无可选项）
      const [caps, cats] = await Promise.all([api.listCapabilities(), api.listSkillCategories()]);
      capabilities.value = caps;
      roleOptions.value = cats;
    } catch {
      capabilities.value = [];
      roleOptions.value = [];
    }
  },
  { immediate: true },
);

async function save() {
  // 保存前先过表单校验（至少选一岗）；失败时表单项内联红字提示，不弹后端错误
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  saving.value = true;
  try {
    const payload: EmployeeDraft = {
      ...form.value,
      id: form.value.id.trim(),
      name: form.value.name.trim(),
      roles: [...form.value.roles], // 多岗位：直接提交 roles 数组（不带单值 role 键）
      ...(bindModel.value
        ? {
            model: {
              api: modelForm.value.api,
              baseUrl: modelForm.value.baseUrl.trim(),
              model: modelForm.value.model.trim(),
              // 编辑已有绑定时留空原样传 ''——后端按「留空保原 key」处理
              apiKey: modelForm.value.apiKey,
            },
          }
        : {}),
    };
    if (isEdit.value) {
      await api.updateEmployee(payload.id, payload);
      ElMessage.success(`员工 ${payload.id} 已更新`);
    } else {
      await api.createEmployee(payload);
      ElMessage.success(`员工 ${payload.id} 已登记`);
    }
    emit('saved');
    emit('update:modelValue', false);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e)); // 后端 400/409 message 原样展示
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    :title="isEdit ? `编辑员工 · ${props.employee?.id}` : '新增员工'"
    width="80%"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
      <el-form-item label="员工 ID">
        <el-input data-test="d-id" v-model="form.id" :disabled="isEdit" placeholder="emp-03" />
      </el-form-item>
      <el-form-item label="姓名">
        <el-input data-test="d-name" v-model="form.name" placeholder="小数" />
      </el-form-item>
      <el-form-item label="岗位" prop="roles">
        <el-select
          data-test="d-role"
          v-model="form.roles"
          multiple
          filterable
          :teleported="false"
          placeholder="选择岗位（可多选）"
          class="!w-full"
        >
          <el-option v-for="c in roleOptions" :key="c.id" :label="c.name" :value="c.name" />
        </el-select>
      </el-form-item>
      <el-form-item label="能力绑定">
        <el-select
          data-test="d-caps"
          v-model="form.capabilities"
          multiple
          :teleported="false"
          placeholder="不选 = 全部能力可用"
          class="!w-full"
        >
          <el-option v-for="c in capabilities.filter((x) => x.enabled)" :key="c.kind" :label="`${c.name} (${c.kind})`" :value="c.kind" />
        </el-select>
      </el-form-item>
      <el-form-item label="盯梢等级">
        <el-select data-test="d-supervision" v-model="form.supervision" :teleported="false" class="!w-full">
          <el-option v-for="s in SUPERVISION_OPTIONS" :key="s" :label="zh(SUPERVISION_ZH, s)" :value="s" />
        </el-select>
        <!-- 三级放权说明（2026-09-11 等级驱动）：黑名单/组合命令三等级均全局拦截 -->
        <div data-test="d-supervision-hint" class="w-full text-gray-400 text-xs leading-5 mt-1">
          盯梢期：节点申报与白名单外命令均需人工放行；辅助期：仅白名单外命令需放行；信任期：白名单外命令直接执行（高危命令仍全局拦截）
        </div>
      </el-form-item>
      <el-form-item label="启用">
        <el-switch data-test="d-enabled" v-model="form.enabled" />
      </el-form-item>
    </el-form>

    <el-divider content-position="left">模型绑定</el-divider>
    <el-form label-width="120px">
      <el-form-item label="绑定专属模型">
        <el-switch data-test="d-bind-model" v-model="bindModel" />
        <span class="text-gray-400 ml-3 text-xs">{{ bindModel ? '一人一模型一 key' : '关 = 使用全局模型' }}</span>
      </el-form-item>
      <template v-if="bindModel">
        <el-form-item label="协议">
          <el-select data-test="d-model-api" v-model="modelForm.api" :teleported="false" class="!w-full">
            <el-option label="OpenAI 兼容" value="openai-completions" />
            <el-option label="Anthropic 兼容" value="anthropic-messages" />
          </el-select>
        </el-form-item>
        <el-form-item label="Base URL">
          <el-input data-test="d-model-baseurl" v-model="modelForm.baseUrl" placeholder="https://llm.bank.cn/v1" />
        </el-form-item>
        <el-form-item label="模型名">
          <el-input data-test="d-model-name" v-model="modelForm.model" placeholder="gpt-4o / claude-sonnet-4" />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input
            data-test="d-model-key"
            v-model="modelForm.apiKey"
            type="password"
            show-password
            :placeholder="hasBinding ? '留空保持原 key' : 'sk-...'"
          />
        </el-form-item>
      </template>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button data-test="save-btn" type="primary" :loading="saving" @click="save">
        {{ isEdit ? '保存' : '登记' }}
      </el-button>
    </template>
  </el-dialog>
</template>
