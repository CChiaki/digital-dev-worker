import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import EmployeeDetail from '../src/views/EmployeeDetail.vue';
import { api } from '../src/api.js';
import { makeTestRouter, mountWithRouter } from './mount-helper.js';

vi.mock('../src/api.js', () => ({
  api: {
    listEmployees: vi.fn(),
    listTasksFiltered: vi.fn(),
    listCapabilities: vi.fn(),
    listSkillCategories: vi.fn(),
    updateEmployee: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

const mockedApi = vi.mocked(api, true);

const EMP = {
  id: 'emp-01', name: '小数', roles: ['backend', 'qa'],
  capabilities: ['dev'], enabled: true, supervision: 'shadow' as const,
  busy: true, runningTasks: ['TASK-1'],
  model: { baseUrl: 'https://llm.bank.cn/v1', apiKey: '***', model: 'gpt-4o', api: 'openai-completions' as const },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.listEmployees.mockResolvedValue([EMP]);
  mockedApi.listCapabilities.mockResolvedValue([]);
});

/** 双 tab 双数据源：按 claimedBy+status 分流 */
function mockTasks() {
  mockedApi.listTasksFiltered.mockImplementation(async (q) => {
    if (q.status === 'claimed,running') {
      return [
        { taskId: 'TASK-1', title: '登录模块开发', status: 'running' as const, claimedBy: 'emp-01', hasResult: false },
        { taskId: 'TASK-2', title: '待执行任务', status: 'claimed' as const, claimedBy: 'emp-01', hasResult: false },
      ];
    }
    return [
      { taskId: 'TASK-3', title: '报表导出', status: 'done' as const, claimedBy: 'emp-01', hasResult: true, reply: '已完成报表导出接口并通过全部验收标准' },
      { taskId: 'TASK-4', title: '失败任务', status: 'failed' as const, claimedBy: 'emp-01', hasResult: false, planProgress: [{ itemId: 'T-1', kind: 'dev', title: '实现接口', status: 'done' as const }, { itemId: 'T-2', kind: 'test', title: '回归测试', status: 'failed' as const }] },
    ];
  });
}

/** 直接 mount 组件（显式传 employeeId props），router 仅承载 push 断言 */
async function mountDetail() {
  const router = makeTestRouter([
    { path: '/employees/:id', component: { template: '<div />' } },
    { path: '/employees/:id/live', component: { template: '<div />' } },
    { path: '/tasks/:id', component: { template: '<div />' } },
  ]);
  // memory router 需先完成初始导航（isReady 才会 resolve）
  await router.push('/employees/emp-01');
  const wrapper = await mountWithRouter(EmployeeDetail, {
    router,
    props: { employeeId: 'emp-01' },
  });
  return { wrapper, router };
}

describe('EmployeeDetail 员工详情页（2026-09-06）', () => {
  it('档案卡渲染：姓名/岗位/盯梢等级/能力绑定/专属模型（key 不回显）', async () => {
    mockTasks();
    const { wrapper } = await mountDetail();
    await flushPromises();

    const text = wrapper.find('[data-test="profile-card"]').text();
    expect(text).toContain('小数');
    expect(text).toContain('backend');
    expect(text).toContain('盯梢期');
    expect(text).toContain('dev');
    expect(text).toContain('gpt-4o');
    expect(text).not.toContain('sk-'); // apiKey 已脱敏
    // 退役字段（2026-09-07 岗位即分类）：详情页不再展示「技能」「技能分类」行
    expect(text).not.toContain('技能');
    wrapper.unmount();
  });

  it('双 tab 数据源参数正确：当前任务 claimedBy+claimed,running；历史任务 done,failed', async () => {
    mockTasks();
    const { wrapper } = await mountDetail();
    await flushPromises();

    expect(mockedApi.listTasksFiltered).toHaveBeenCalledWith({ claimedBy: 'emp-01', status: 'claimed,running' });
    expect(mockedApi.listTasksFiltered).toHaveBeenCalledWith({ claimedBy: 'emp-01', status: 'done,failed' });
    // 默认当前任务 tab：2 行执行中任务
    expect(wrapper.findAll('[data-test="task-table"] .el-table__row').length).toBe(2);
    // 切历史任务 tab：数据源切换为 done,failed
    await wrapper.findAll('.el-tabs__item')[1]!.trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-test="task-table"] .el-table__row').length).toBe(2);
    expect(wrapper.find('[data-test="task-table"]').text()).toContain('已完成');
    wrapper.unmount();
  });

  it('历史任务列：planProgress 摘要与 result.reply 展示', async () => {
    mockTasks();
    const { wrapper } = await mountDetail();
    await flushPromises();
    await wrapper.findAll('.el-tabs__item')[1]!.trigger('click');
    await flushPromises();

    const rows = wrapper.findAll('[data-test="task-table"] .el-table__row');
    expect(rows[0]!.text()).toContain('已完成报表导出接口并通过全部验收标准'); // reply
    expect(rows[1]!.text()).toContain('1/2 项 · 1 项停点'); // planProgress 摘要
    wrapper.unmount();
  });

  it('执行中行有「进入直播」按钮 → /employees/emp-01/live', async () => {
    mockTasks();
    const { wrapper, router } = await mountDetail();
    await flushPromises();

    const rows = wrapper.findAll('[data-test="task-table"] .el-table__row');
    expect(rows[0]!.find('[data-test="live-btn"]').exists()).toBe(true); // running 行
    expect(rows[1]!.find('[data-test="live-btn"]').exists()).toBe(true); // claimed 行
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined as never);
    await rows[0]!.find('[data-test="live-btn"]').trigger('click');
    expect(push).toHaveBeenCalledWith('/employees/emp-01/live');
    wrapper.unmount();
  });

  it('点击任务行 → router.push /tasks/:taskId（下钻任务详情）', async () => {
    mockTasks();
    const { wrapper, router } = await mountDetail();
    await flushPromises();
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined as never);

    await wrapper.findAll('[data-test="task-table"] .el-table__row')[0]!.trigger('click');
    expect(push).toHaveBeenCalledWith('/tasks/TASK-1');
    wrapper.unmount();
  });

  it('返回按钮：history 有上一页 → router.back（2026-09-06）', async () => {
    mockTasks();
    const { wrapper, router } = await mountDetail();
    await flushPromises();
    const back = vi.spyOn(router, 'back').mockImplementation(() => {});
    const orig = Object.getOwnPropertyDescriptor(window.history, 'state');
    Object.defineProperty(window.history, 'state', { value: { back: '/employees' }, configurable: true, writable: true });

    try {
      await wrapper.find('[data-test="back-btn"]').trigger('click');
      expect(back).toHaveBeenCalled();
    } finally {
      if (orig) Object.defineProperty(window.history, 'state', orig);
      wrapper.unmount();
    }
  });

  it('编辑按钮打开共用对话框（EmployeeEditDialog），保存后走 updateEmployee', async () => {
    mockedApi.updateEmployee.mockResolvedValue({ id: 'emp-01' } as never);
    const { wrapper } = await mountDetail();
    await flushPromises();

    expect(wrapper.find('[data-test="d-id"]').exists()).toBe(false); // 未打开
    await wrapper.find('[data-test="edit-btn"]').trigger('click');
    await flushPromises();
    const idInput = wrapper.find('[data-test="d-id"]');
    expect((idInput.element as HTMLInputElement).value).toBe('emp-01'); // data-test 落在 el-input 内部原生 input 上 // 共用对话框回显
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();
    expect(mockedApi.updateEmployee).toHaveBeenCalledWith('emp-01', expect.objectContaining({ id: 'emp-01' }));
    wrapper.unmount();
  });

  it('技能标签/技能分类输入已退役：编辑对话框不再渲染，分类表接口转作岗位下拉数据源（2026-09-07）', async () => {
    mockedApi.listSkillCategories.mockResolvedValue([
      { id: 'backend', name: '后端开发' },
      { id: 'frontend', name: '前端开发' },
    ] as never);
    const { wrapper } = await mountDetail();
    await flushPromises();

    await wrapper.find('[data-test="edit-btn"]').trigger('click');
    await flushPromises();
    // 退役字段不再渲染（2026-09-07 岗位即技能库）
    expect(wrapper.find('[data-test="d-skill-cats"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="d-skills"]').exists()).toBe(false);
    // 分类表接口仍被拉取，但作为岗位下拉数据源（role 存岗位名字符串）
    expect(mockedApi.listSkillCategories).toHaveBeenCalled();
    expect(wrapper.find('[data-test="d-role"]').find('.el-select__wrapper').exists()).toBe(true);
    wrapper.unmount();
  });
});
