import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
// ElMessage / ElMessageBox 打桩：error 断言后端 400/409 文案；confirm 默认放行（停用路径）
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    ElMessageBox: { confirm: vi.fn().mockResolvedValue(true) },
  };
});
import { ElMessage, ElMessageBox } from 'element-plus';
import Employees from '../src/views/Employees.vue';
import { api } from '../src/api.js';
import { makeTestRouter, mountWithRouter } from './mount-helper.js';

vi.mock('../src/api.js', () => ({
  api: {
    listEmployees: vi.fn(),
    createEmployee: vi.fn(),
    updateEmployee: vi.fn(),
    disableEmployee: vi.fn(),
    listCapabilities: vi.fn(),
    listSkillCategories: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

const mockedApi = vi.mocked(api, true);
const mockedMsg = vi.mocked(ElMessage, true);
const mockedBox = vi.mocked(ElMessageBox, true);

// 岗位清单 = 分类表（2026-09-07 岗位即分类）：对话框岗位下拉数据源
const ROLES = [
  { id: 'backend', name: 'backend' },
  { id: 'frontend', name: 'frontend' },
  { id: 'qa', name: 'qa' },
];

const EMPS = [
  { id: 'emp-01', name: '小数', roles: ['backend', 'qa'], capabilities: ['dev'], enabled: true, supervision: 'shadow' as const, busy: true, runningTasks: ['TASK-1'] },
  { id: 'emp-02', name: '小智', roles: ['frontend'], capabilities: [], enabled: false, supervision: 'trusted' as const, busy: false, runningTasks: [] },
];

function mountPage() {
  return mountWithRouter(Employees, {
    router: makeTestRouter([
      { path: '/employees', component: Employees },
      { path: '/employees/:id', component: { template: '<div />' } },
    ]),
    path: '/employees',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedBox.confirm.mockResolvedValue(true as never);
  mockedApi.listEmployees.mockResolvedValue(EMPS);
  mockedApi.listCapabilities.mockResolvedValue([]);
  mockedApi.listSkillCategories.mockResolvedValue(ROLES as never);
});

// 岗位下拉选择（2026-09-07 岗位改下拉单选）：点开 d-role → 点选目标岗位选项
async function selectRole(wrapper: Awaited<ReturnType<typeof mountWithRouter>>, name: string) {
  await wrapper.find('[data-test="d-role"]').trigger('click');
  await flushPromises();
  const opt = wrapper.findAll('.el-select-dropdown__item').find((o) => o.text() === name);
  expect(opt).toBeTruthy();
  await opt!.trigger('click');
  await flushPromises();
}

describe('Employees 数字员工管理页（2026-09-06）', () => {
  it('表格渲染：id/姓名/岗位/能力绑定（空显示全部）/盯梢等级中文/忙闲（含执行中任务）', async () => {
    const wrapper = await mountPage();
    await flushPromises();

    const rows = wrapper.findAll('[data-test="emp-table"] .el-table__row');
    expect(rows.length).toBe(2);
    const first = rows[0]!.text();
    expect(first).toContain('emp-01');
    expect(first).toContain('小数');
    expect(first).toContain('backend');
    expect(first).toContain('qa'); // 多岗位：roles 数组逐个渲染
    expect(first).toContain('盯梢期'); // supervision 中文映射
    expect(first).toContain('执行中');
    expect(first).toContain('TASK-1'); // busy/runningTasks 信息呈现（Task 7 交接）
    expect(wrapper.find('[data-test="emp-table"]').text()).toContain('全部'); // 能力绑定空 → 全部
    wrapper.unmount();
  });

  it('关键词过滤员工列表（姓名/岗位，2026-09-06）', async () => {
    const wrapper = await mountPage();
    await flushPromises();

    await wrapper.find('[data-test="employees-search"]').setValue('backend');
    let rows = wrapper.findAll('[data-test="emp-table"] .el-table__row');
    expect(rows.length).toBe(1);
    expect(rows[0]!.text()).toContain('小数');

    await wrapper.find('[data-test="employees-search"]').setValue('小智'); // 姓名匹配
    rows = wrapper.findAll('[data-test="emp-table"] .el-table__row');
    expect(rows.length).toBe(1);
    expect(rows[0]!.text()).toContain('emp-02');
    wrapper.unmount();
  });

  it('岗位列 tags：多岗位逐个渲染 el-tag（2026-09-07 员工多岗位）', async () => {
    const wrapper = await mountPage();
    await flushPromises();

    const rows = wrapper.findAll('[data-test="emp-table"] .el-table__row');
    const firstRoleTags = rows[0]!.findAll('.el-tag').map((t) => t.text());
    expect(firstRoleTags).toContain('backend');
    expect(firstRoleTags).toContain('qa'); // emp-01 双岗 → 两个 tag
    expect(rows[1]!.findAll('.el-tag').map((t) => t.text())).toContain('frontend');
    wrapper.unmount();
  });

  it('新增员工：对话框提交 → createEmployee（未绑模型 model 不上送）', async () => {
    mockedApi.createEmployee.mockResolvedValue({ id: 'emp-03' } as never);
    const wrapper = await mountPage();
    await flushPromises();

    await wrapper.find('[data-test="create-btn"]').trigger('click');
    await wrapper.find('[data-test="d-id"]').setValue('emp-03');
    await wrapper.find('[data-test="d-name"]').setValue('小智');
    await selectRole(wrapper, 'frontend'); // 岗位下拉单选（2026-09-07）
    // 「绑定专属模型」关 → 提交 model 置 undefined
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();

    // skills/skillCategories/单值 role 已退役（2026-09-07）：payload 携带 roles 数组
    expect(mockedApi.createEmployee).toHaveBeenCalledWith({
      id: 'emp-03', name: '小智', roles: ['frontend'],
      capabilities: [], supervision: 'shadow', enabled: true,
    });
    expect(mockedMsg.success).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('模型绑定区：开启开关后提交携带 model（协议/baseUrl/model/apiKey）', async () => {
    mockedApi.createEmployee.mockResolvedValue({ id: 'emp-03' } as never);
    const wrapper = await mountPage();
    await flushPromises();

    await wrapper.find('[data-test="create-btn"]').trigger('click');
    await wrapper.find('[data-test="d-id"]').setValue('emp-03');
    await wrapper.find('[data-test="d-name"]').setValue('小数');
    await selectRole(wrapper, 'backend');
    await wrapper.find('[data-test="d-bind-model"]').find('.el-switch__core').trigger('click');
    await wrapper.find('[data-test="d-model-baseurl"]').setValue('https://llm.bank.cn/v1');
    await wrapper.find('[data-test="d-model-name"]').setValue('gpt-4o');
    await wrapper.find('[data-test="d-model-key"]').setValue('sk-xxx');
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();

    expect(mockedApi.createEmployee).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { api: 'openai-completions', baseUrl: 'https://llm.bank.cn/v1', model: 'gpt-4o', apiKey: 'sk-xxx' },
      }),
    );
    wrapper.unmount();
  });

  it('新增提交失败（409 id 冲突）：错误经 ElMessage.error 原样展示，对话框保持打开', async () => {
    mockedApi.createEmployee.mockRejectedValue(new Error('员工 id 已存在: emp-03'));
    const wrapper = await mountPage();
    await flushPromises();

    await wrapper.find('[data-test="create-btn"]').trigger('click');
    await wrapper.find('[data-test="d-id"]').setValue('emp-03');
    await wrapper.find('[data-test="d-name"]').setValue('重复');
    await selectRole(wrapper, 'qa');
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();

    expect(mockedMsg.error).toHaveBeenCalledWith('员工 id 已存在: emp-03');
    expect(wrapper.find('[data-test="d-id"]').exists()).toBe(true); // 对话框未关闭
    wrapper.unmount();
  });

  it('停用：switch off → confirm「历史任务保留」→ disableEmployee；启用：switch on → updateEmployee 整行提交', async () => {
    const router = makeTestRouter([
      { path: '/employees', component: Employees },
      { path: '/employees/:id', component: { template: '<div />' } },
    ]);
    const wrapper = await mountWithRouter(Employees, { router, path: '/employees' });
    await flushPromises();
    // 挂载初始跳转后 spy：点击行内 switch 不得冒泡触发行下钻导航（router.push）
    const pushSpy = vi.spyOn(router, 'push');
    expect(pushSpy).not.toHaveBeenCalled(); // 基线：挂载期未产生额外导航

    // 停用 emp-01
    await wrapper.find('[data-test="enable-switch-emp-01"]').find('.el-switch__core').trigger('click');
    await flushPromises();
    expect(pushSpy).not.toHaveBeenCalled(); // switch 点击不冒泡 → 不触发行导航
    expect(mockedBox.confirm).toHaveBeenCalledWith(expect.stringContaining('历史任务保留'), '停用员工', expect.anything());
    expect(mockedApi.disableEmployee).toHaveBeenCalledWith('emp-01');

    // 启用 emp-02：updateEmployee 整行（enabled 翻转）
    await wrapper.find('[data-test="enable-switch-emp-02"]').find('.el-switch__core').trigger('click');
    await flushPromises();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(mockedApi.updateEmployee).toHaveBeenCalledWith('emp-02', expect.objectContaining({ id: 'emp-02', enabled: true, roles: ['frontend'] }));
    wrapper.unmount();
  });

  it('点击编辑按钮 → 对话框回显档案，id 只读，提交走 updateEmployee', async () => {
    mockedApi.updateEmployee.mockResolvedValue({ id: 'emp-01' } as never);
    const wrapper = await mountPage();
    await flushPromises();

    const row = wrapper.findAll('[data-test="emp-table"] .el-table__row')[0]!;
    await row.find('[data-test="edit-btn"]').trigger('click');
    await flushPromises();
    const idInput = wrapper.find('[data-test="d-id"]');
    expect((idInput.element as HTMLInputElement).value).toBe('emp-01'); // data-test 落在 el-input 内部原生 input 上
    expect((idInput.element as HTMLInputElement).disabled).toBe(true); // 编辑模式 id 只读
    await wrapper.find('[data-test="d-name"]').setValue('小数改');
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();

    expect(mockedApi.updateEmployee).toHaveBeenCalledWith(
      'emp-01',
      expect.objectContaining({ id: 'emp-01', name: '小数改', roles: ['backend', 'qa'], capabilities: ['dev'] }),
    );
    wrapper.unmount();
  });
});
