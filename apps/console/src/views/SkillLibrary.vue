<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRoute } from 'vue-router';
import { api, type SkillRecordView, type SkillCategoryView, type SkillType } from '../api.js';

const skills = ref<SkillRecordView[]>([]);
const categories = ref<SkillCategoryView[]>([]);
const loading = ref(false);
const error = ref('');

/** 检索区（列表页风格统一）：关键词 + 岗位 + 状态（2026-09-07 岗位即分类，界面文案统一「岗位」） */
const keyword = ref('');
const filterCategory = ref('');
const filterStatus = ref('');

const TYPE_ZH: Record<SkillType, string> = { knowledge: '知识', constraint: '约束', asset: '资产' };
const STATUS_ZH: Record<string, string> = { pending: '待审查', approved: '已批准', rejected: '已驳回' };
const STATUS_TAG: Record<string, 'warning' | 'success' | 'danger'> = { pending: 'warning', approved: 'success', rejected: 'danger' };

const matches = (s: SkillRecordView): boolean => {
  const k = keyword.value.trim().toLowerCase();
  return (!k || s.name.toLowerCase().includes(k) || s.description.toLowerCase().includes(k))
    && (!filterCategory.value || s.categoryId === filterCategory.value)
    && (!filterStatus.value || s.status === filterStatus.value);
};
const filtered = computed(() => skills.value.filter(matches));
const pendingCount = computed(() => skills.value.filter((s) => s.status === 'pending').length);

// 深链预筛（2026-09-11 用户需求）：左侧菜单「Skill 待审查」角标点击带 ?status=pending 进入，直接落在待审查筛选
const route = useRoute();
if (route.query.status === 'pending') filterStatus.value = 'pending';

/** 待审查角标点击 = 快速筛选开关（2026-09-11 用户需求）：点一下只看待审查，再点恢复全部 */
function togglePendingFilter(): void {
  filterStatus.value = filterStatus.value === 'pending' ? '' : 'pending';
}

const catName = (id: string): string => categories.value.find((c) => c.id === id)?.name ?? id;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [list, cats] = await Promise.all([api.listSkills(), api.listSkillCategories()]);
    skills.value = list;
    categories.value = cats;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/* ---- 新建/编辑对话框 ---- */
const dialogVisible = ref(false);
const editingId = ref('');
const saving = ref(false);
const draft = ref(emptyDraft());
const assetRows = ref<{ path: string; content: string }[]>([]);

function emptyDraft() {
  return { categoryId: 'backend', name: '', description: '', type: 'knowledge' as SkillType, content: '' };
}

function openCreate() {
  editingId.value = '';
  draft.value = emptyDraft();
  assetRows.value = [];
  dialogVisible.value = true;
}

function openEdit(row: SkillRecordView) {
  editingId.value = row.id;
  draft.value = { categoryId: row.categoryId, name: row.name, description: row.description, type: row.type, content: row.content };
  assetRows.value = (row.assetFiles ?? []).map((f) => ({ ...f }));
  dialogVisible.value = true;
}

async function save() {
  saving.value = true;
  try {
    const payload = {
      ...draft.value,
      ...(draft.value.type === 'asset' && assetRows.value.length ? { assetFiles: assetRows.value } : {}),
    };
    if (editingId.value) {
      await api.updateSkill(editingId.value, payload);
      ElMessage.success(`skill ${draft.value.name} 已更新`);
    } else {
      await api.createSkill(payload);
      ElMessage.success(`skill ${draft.value.name} 已提交待审查`);
    }
    dialogVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e)); // 后端 400 原样展示
  } finally {
    saving.value = false;
  }
}

/* ---- 审查 ---- */
async function review(row: SkillRecordView, action: 'approve' | 'reject') {
  if (action === 'reject') {
    try { await ElMessageBox.confirm(`确认驳回 skill「${row.name}」？`, '驳回', { type: 'warning' }); } catch { return; }
  }
  try {
    await api.reviewSkill(row.id, action);
    ElMessage.success(action === 'approve' ? '已批准入库' : '已驳回');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function remove(row: SkillRecordView) {
  try { await ElMessageBox.confirm(`确认删除 skill「${row.name}」？`, '删除', { type: 'warning' }); } catch { return; }
  try {
    await api.deleteSkill(row.id);
    ElMessage.success('已删除');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

/* ---- 岗位管理对话框（分类表 CRUD，界面文案改「岗位」） ---- */
const catsVisible = ref(false);
const newCat = ref({ id: '', name: '' });

async function addCategory() {
  try {
    await api.createSkillCategory({ id: newCat.value.id.trim(), name: newCat.value.name.trim() });
    ElMessage.success('岗位已新增');
    newCat.value = { id: '', name: '' };
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function removeCategory(cat: SkillCategoryView) {
  try { await ElMessageBox.confirm(`确认删除岗位「${cat.name}」？`, '删除岗位', { type: 'warning' }); } catch { return; }
  try {
    await api.deleteSkillCategory(cat.id);
    ElMessage.success('岗位已删除');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e)); // 409 挂载保护文案原样展示
  }
}

onMounted(load);
</script>

<template>
  <section class="view">
    <h2>Skill 库 <span class="ml-3 text-sm font-normal text-gray-400">数字员工公用技能库 · 入库需人工终审</span></h2>

    <div class="flex items-center gap-3 mb-4">
      <el-input v-model="keyword" data-test="skills-search" placeholder="按名称/说明检索" clearable class="!w-56" />
      <el-select v-model="filterCategory" data-test="filter-category" placeholder="全部岗位" clearable class="!w-40" :teleported="false">
        <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-select v-model="filterStatus" data-test="filter-status" placeholder="全部状态" clearable class="!w-36" :teleported="false">
        <el-option label="待审查" value="pending" />
        <el-option label="已批准" value="approved" />
        <el-option label="已驳回" value="rejected" />
      </el-select>
      <!-- 待审查角标可点（2026-09-11 用户需求）：点击快速筛选待审查，再点恢复全部 -->
      <el-badge
        :value="pendingCount" :hidden="pendingCount === 0" data-test="pending-badge"
        class="cursor-pointer select-none" title="点击快速筛选待审查" @click="togglePendingFilter"
      >
        <span class="text-sm" :class="filterStatus === 'pending' ? 'font-medium text-[#2f6bff]' : 'text-gray-400'">待审查</span>
      </el-badge>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="flex-1" />
      <div class="ml-auto flex gap-2">
        <el-button data-test="manage-cats-btn" @click="catsVisible = true">岗位管理</el-button>
        <el-button data-test="create-btn" type="primary" @click="openCreate">新增 Skill</el-button>
      </div>
    </div>

    <el-card shadow="never">
      <p v-if="loading && skills.length === 0" class="text-gray-400">加载中…</p>
      <el-empty v-else-if="skills.length === 0" description="暂无 skill，任务完成后会自动沉淀候选" />
      <template v-else>
        <el-table :data="filtered" data-test="skill-table">
          <el-table-column prop="name" label="名称" min-width="150" />
          <el-table-column label="岗位" width="110">
            <template #default="scope">{{ catName(scope.row.categoryId) }}</template>
          </el-table-column>
          <el-table-column label="类型" width="80">
            <template #default="scope"><el-tag size="small">{{ TYPE_ZH[scope.row.type as SkillType] }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="description" label="说明" min-width="160" show-overflow-tooltip />
          <el-table-column label="状态" width="100">
            <template #default="scope">
              <el-tag :type="STATUS_TAG[scope.row.status]" size="small">{{ STATUS_ZH[scope.row.status] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="来源" width="140">
            <template #default="scope">
              <span class="text-[13px] text-gray-500">{{ scope.row.source === 'manual' ? '手工录入' : scope.row.source }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="230">
            <template #default="scope">
              <template v-if="scope.row.status === 'pending'">
                <el-button data-test="approve-btn" link type="success" @click="review(scope.row, 'approve')">批准</el-button>
                <el-button data-test="reject-btn" link type="warning" @click="review(scope.row, 'reject')">驳回</el-button>
              </template>
              <el-button data-test="edit-btn" link type="primary" @click="openEdit(scope.row)">编辑</el-button>
              <el-button data-test="delete-btn" link type="danger" @click="remove(scope.row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <p v-if="filtered.length === 0" class="text-center text-gray-400 py-10">无匹配 skill</p>
      </template>
    </el-card>

    <!-- 新建/编辑对话框 -->
    <el-dialog v-model="dialogVisible" :title="editingId ? `编辑 Skill · ${editingId}` : '新增 Skill（提交后待审查）'" width="70%">
      <el-form label-width="120px">
        <el-form-item label="岗位">
          <el-select v-model="draft.categoryId" data-test="d-category" class="!w-full" :teleported="false">
            <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="draft.type" data-test="d-type" class="!w-full" :teleported="false">
            <el-option label="知识（knowledge）" value="knowledge" />
            <el-option label="约束（constraint）" value="constraint" />
            <el-option label="资产（asset）" value="asset" />
          </el-select>
        </el-form-item>
        <el-form-item label="名称">
          <el-input data-test="d-name" v-model="draft.name" placeholder="接口异常码规范" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input data-test="d-description" v-model="draft.description" placeholder="一句话说明（可空）" />
        </el-form-item>
        <el-form-item :label="draft.type === 'asset' ? '使用说明' : '正文'">
          <el-input data-test="d-content" v-model="draft.content" type="textarea" :rows="6" placeholder="markdown 正文（执行任务时注入员工上下文）" />
        </el-form-item>
        <el-form-item v-if="draft.type === 'asset'" label="资产文件">
          <div class="w-full">
            <div v-for="(f, i) in assetRows" :key="i" class="flex gap-2 mb-2">
              <el-input v-model="f.path" placeholder="相对路径，如 scripts/check.sh" class="!w-72" />
              <el-input v-model="f.content" type="textarea" :rows="2" placeholder="文件内容" class="flex-1" />
              <el-button link type="danger" @click="assetRows.splice(i, 1)">删除</el-button>
            </div>
            <el-button size="small" @click="assetRows.push({ path: '', content: '' })">+ 添加文件</el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button data-test="save-btn" type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 岗位管理对话框（数据仍是分类表，仅界面文案改「岗位」） -->
    <el-dialog v-model="catsVisible" title="岗位管理" width="520px">
      <div class="mb-3">
        <div v-for="c in categories" :key="c.id" class="flex items-center gap-2 py-1.5 border-b border-gray-100">
          <code class="w-24">{{ c.id }}</code>
          <span class="flex-1">{{ c.name }}</span>
          <el-button link type="danger" @click="removeCategory(c)">删除</el-button>
        </div>
      </div>
      <div class="flex gap-2">
        <el-input data-test="cat-id" v-model="newCat.id" placeholder="岗位 id（如 data）" class="!w-40" />
        <el-input data-test="cat-name" v-model="newCat.name" placeholder="岗位名称" class="!w-48" />
        <el-button data-test="cat-save-btn" type="primary" @click="addCategory">新增</el-button>
      </div>
    </el-dialog>
  </section>
</template>
