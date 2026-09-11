import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import SkillLibrary from '../src/views/SkillLibrary.vue';
import { api, type SkillRecordView, type SkillCategoryView } from '../src/api.js';
import { mountWithRouter, makeTestRouter } from './mount-helper.js';

vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    ElMessageBox: { confirm: vi.fn().mockResolvedValue(true) },
  };
});

vi.mock('../src/api.js', () => ({
  api: {
    listSkills: vi.fn(),
    createSkill: vi.fn(),
    updateSkill: vi.fn(),
    deleteSkill: vi.fn(),
    reviewSkill: vi.fn(),
    listSkillCategories: vi.fn(),
    createSkillCategory: vi.fn(),
    deleteSkillCategory: vi.fn(),
  },
}));

import { ElMessage } from 'element-plus';

const mockedApi = vi.mocked(api, true);
const mockedMsg = vi.mocked(ElMessage, true);

/** 页面挂载统一走路由化（2026-09-11 深链需求：SkillLibrary 读 route.query.status） */
async function mountPage(path = '/skills') {
  const router = makeTestRouter([{ path: '/skills', component: SkillLibrary }]);
  const wrapper = await mountWithRouter(SkillLibrary, { router, path });
  await flushPromises();
  return wrapper;
}

const CATS: SkillCategoryView[] = [
  { id: 'backend', name: '后端开发' }, { id: 'frontend', name: '前端开发' },
];
const SKILLS: SkillRecordView[] = [
  { id: 'skill-1', categoryId: 'backend', name: '异常码规范', description: 'REST 约定', type: 'knowledge', content: 'E 开头', status: 'pending', source: 'auto:T1', sourceTaskId: 'T1', createdAt: 1 },
  { id: 'skill-2', categoryId: 'backend', name: '禁直连生产库', description: '', type: 'constraint', content: '禁止', status: 'approved', source: 'manual', createdAt: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.listSkillCategories.mockResolvedValue(CATS);
  mockedApi.listSkills.mockResolvedValue(SKILLS);
});

describe('SkillLibrary（2026-09-06 Skill 库页）', () => {
  it('渲染表格：名称/岗位/类型/状态；pending 行有批准/驳回按钮', async () => {
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain('异常码规范');
    expect(wrapper.text()).toContain('禁直连生产库');
    expect(wrapper.text()).toContain('岗位'); // 分类列文案已改「岗位」（2026-09-07 岗位即分类）
    const rows = wrapper.findAll('[data-test="skill-table"] .el-table__row');
    expect(rows[0]!.find('[data-test="approve-btn"]').exists()).toBe(true);
    expect(rows[0]!.find('[data-test="reject-btn"]').exists()).toBe(true);
    expect(rows[1]!.find('[data-test="approve-btn"]').exists()).toBe(false); // 非 pending 无审查按钮
  });

  it('审查流：批准 → reviewSkill(approve) + 刷新', async () => {
    mockedApi.reviewSkill.mockResolvedValue({ id: 'skill-1', status: 'approved' } as never);
    const wrapper = await mountPage();
    await wrapper.find('[data-test="approve-btn"]').trigger('click');
    await flushPromises();
    expect(mockedApi.reviewSkill).toHaveBeenCalledWith('skill-1', 'approve');
    expect(mockedApi.listSkills).toHaveBeenCalledTimes(2);
    expect(mockedMsg.success).toHaveBeenCalled();
  });

  it('驳回：confirm 后 reviewSkill(reject)', async () => {
    mockedApi.reviewSkill.mockResolvedValue({ id: 'skill-1', status: 'rejected' } as never);
    const wrapper = await mountPage();
    await wrapper.find('[data-test="reject-btn"]').trigger('click');
    await flushPromises();
    expect(mockedApi.reviewSkill).toHaveBeenCalledWith('skill-1', 'reject');
  });

  it('检索过滤 + 待审查徽标', async () => {
    const wrapper = await mountPage();
    expect(wrapper.find('[data-test="pending-badge"]').text()).toContain('1');
    await wrapper.find('[data-test="skills-search"]').setValue('禁直连');
    const rows = wrapper.findAll('[data-test="skill-table"] .el-table__row');
    expect(rows.length).toBe(1);
    expect(rows[0]!.text()).toContain('禁直连生产库');
  });

  it('待审查角标点击快速筛选（2026-09-11 用户需求）：点一下只看待审查，再点恢复全部', async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-test="pending-badge"]').trigger('click');
    let rows = wrapper.findAll('[data-test="skill-table"] .el-table__row');
    expect(rows.length).toBe(1);
    expect(rows[0]!.text()).toContain('异常码规范');
    await wrapper.find('[data-test="pending-badge"]').trigger('click');
    rows = wrapper.findAll('[data-test="skill-table"] .el-table__row');
    expect(rows.length).toBe(2);
  });

  it('深链 ?status=pending（2026-09-11 用户需求）：左侧菜单角标跳转落地即待审查筛选', async () => {
    const wrapper = await mountPage('/skills?status=pending');
    const rows = wrapper.findAll('[data-test="skill-table"] .el-table__row');
    expect(rows.length).toBe(1);
    expect(rows[0]!.text()).toContain('异常码规范');
  });

  it('新建 skill：对话框提交 → createSkill（201 后刷新）', async () => {
    mockedApi.createSkill.mockResolvedValue({ id: 'skill-9', status: 'pending' } as never);
    const wrapper = await mountPage();
    await wrapper.find('[data-test="create-btn"]').trigger('click');
    await wrapper.find('[data-test="d-name"]').setValue('新技能');
    await wrapper.find('[data-test="d-content"]').setValue('正文');
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();
    expect(mockedApi.createSkill).toHaveBeenCalled();
    expect(mockedMsg.success).toHaveBeenCalled();
  });

  it('删除：confirm → deleteSkill', async () => {
    mockedApi.deleteSkill.mockResolvedValue({ id: 'skill-1', removed: true } as never);
    const wrapper = await mountPage();
    const row = wrapper.findAll('[data-test="skill-table"] .el-table__row')[0]!;
    await row.find('[data-test="delete-btn"]').trigger('click');
    await flushPromises();
    expect(mockedApi.deleteSkill).toHaveBeenCalledWith('skill-1');
  });

  it('岗位管理入口文案为「岗位管理」：按钮与对话框标题均改岗位（2026-09-07 岗位即分类）', async () => {
    mockedApi.createSkillCategory.mockResolvedValue({ id: 'data' } as never);
    const wrapper = await mountPage();

    // 入口按钮文案含「岗位管理」（原「管理分类」；data-test 标识符不改）
    const btn = wrapper.find('[data-test="manage-cats-btn"]');
    expect(btn.text()).toContain('岗位管理');
    await btn.trigger('click');
    await flushPromises();

    // 对话框标题含「岗位管理」（EP dialog 可能 teleport 到 body，用 document 兜底查）
    const title = wrapper.find('.el-dialog__title').exists()
      ? wrapper.find('.el-dialog__title').text()
      : (document.querySelector('.el-dialog__title')?.textContent ?? '');
    expect(title).toContain('岗位管理');
    // 对话框内岗位清单可见、可新增
    expect(wrapper.text()).toContain('后端开发');
    await wrapper.find('[data-test="cat-id"]').setValue('data');
    await wrapper.find('[data-test="cat-name"]').setValue('数据开发');
    await wrapper.find('[data-test="cat-save-btn"]').trigger('click');
    await flushPromises();
    expect(mockedApi.createSkillCategory).toHaveBeenCalledWith({ id: 'data', name: '数据开发' });
  });
});
