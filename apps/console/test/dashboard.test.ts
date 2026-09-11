import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import Dashboard from '../src/views/Dashboard.vue';
import { api } from '../src/api.js';
import { makeTestRouter, mountWithRouter } from './mount-helper.js';

vi.mock('../src/api.js', () => ({
  api: {
    listEmployees: vi.fn(),
    listTasksFiltered: vi.fn(),
    listChecks: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

const mockedApi = vi.mocked(api, true);

beforeEach(() => {
  vi.clearAllMocks();
});

/** memory router 需先完成初始导航（isReady 才会 resolve），统一 push 后挂载 */
async function mountDash(routes: Parameters<typeof makeTestRouter>[0]) {
  const router = makeTestRouter(routes);
  await router.push('/');
  return { wrapper: await mountWithRouter(Dashboard, { router }), router };
}

const EMPS = [
  { id: 'emp-01', name: '小数', roles: ['backend'], capabilities: ['dev', 'test'], enabled: true, supervision: 'shadow' as const, busy: true, runningTasks: ['TASK-1'] },
  { id: 'emp-02', name: '小智', roles: ['frontend'], capabilities: [], enabled: false, supervision: 'trusted' as const, busy: false, runningTasks: [] },
];

/** 按查询参数分流：进行中 1 / 已完成 2（emp-01 两单）/ 失败 1 */
function mockTasks() {
  mockedApi.listTasksFiltered.mockImplementation(async (q) => {
    if (q.status === 'claimed,running') return [{ taskId: 'TASK-1', title: '登录模块开发', status: 'running' as const, hasResult: false }];
    if (q.status === 'done') {
      return [
        { taskId: 'TASK-2', title: '报表导出', status: 'done' as const, claimedBy: 'emp-01', hasResult: true },
        { taskId: 'TASK-3', title: '消息中心', status: 'done' as const, claimedBy: 'emp-01', hasResult: true },
      ];
    }
    return [{ taskId: 'TASK-4', title: '失败任务', status: 'failed' as const, hasResult: false }];
  });
}

describe('Dashboard 首页面板（2026-09-06）', () => {
  it('渲染 2 张员工卡：姓名/岗位/忙闲/能力徽标（空=全部能力）/完成任务数', async () => {
    mockedApi.listEmployees.mockResolvedValue(EMPS);
    mockTasks();
    mockedApi.listChecks.mockResolvedValue([]);
    const { wrapper } = await mountDash([{ path: '/', component: Dashboard }]);
    await flushPromises();

    const cards = wrapper.findAll('[data-test="employee-emp-01"], [data-test="employee-emp-02"]');
    expect(cards.length).toBe(2);
    const text = wrapper.find('[data-test="employee-emp-01"]').text();
    expect(text).toContain('小数');
    expect(text).toContain('backend');
    expect(text).toContain('执行中');
    expect(wrapper.find('[data-test="employee-emp-01"] .cap-tag').exists()).toBe(true);
    // capabilities 空 → 「全部能力」
    expect(wrapper.find('[data-test="employee-emp-02"]').text()).toContain('全部能力');
    // emp-01 完成任务 2 单
    expect(wrapper.find('[data-test="employee-emp-01"] [data-test="done-count"]').text()).toBe('2');
    // 停用员工卡灰显（opacity-55 + grayscale）
    expect(wrapper.find('[data-test="employee-emp-02"]').classes()).toContain('opacity-55');
    wrapper.unmount();
  });

  it('任务统计四卡：进行中/已完成/失败/待放行 计数正确', async () => {
    mockedApi.listEmployees.mockResolvedValue(EMPS);
    mockTasks();
    mockedApi.listChecks.mockResolvedValue([{ taskId: 'TASK-4', item: 'T-1', result: '构建通过' }]);
    const { wrapper } = await mountDash([{ path: '/', component: Dashboard }]);
    await flushPromises();

    expect(wrapper.find('[data-test="stat-running"]').text()).toContain('1');
    expect(wrapper.find('[data-test="stat-done"]').text()).toContain('2');
    expect(wrapper.find('[data-test="stat-failed"]').text()).toContain('1');
    expect(wrapper.find('[data-test="stat-checks"]').text()).toContain('1');
    wrapper.unmount();
  });

  it('统计卡含图标块与数字分区；员工区浅灰背景与统计区视觉分区', async () => {
    mockedApi.listEmployees.mockResolvedValue(EMPS);
    mockTasks();
    mockedApi.listChecks.mockResolvedValue([]);
    const { wrapper } = await mountDash([{ path: '/', component: Dashboard }]);
    await flushPromises();

    expect(wrapper.find('[data-test="stat-running"] .stat-icon').exists()).toBe(true);
    expect(wrapper.find('[data-test="emp-section"]').classes()).toContain('bg-gray-50');
    wrapper.unmount();
  });

  it('失败统计卡红色主题，点击跳 /tasks', async () => {
    mockedApi.listEmployees.mockResolvedValue(EMPS);
    mockTasks();
    mockedApi.listChecks.mockResolvedValue([]);
    const { wrapper, router } = await mountDash([
      { path: '/', component: Dashboard },
      { path: '/tasks', component: { template: '<div />' } },
    ]);
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined as never);
    await flushPromises();

    // 失败卡红色主题：数字 text-red-500 + 可点击
    const failedCard = wrapper.find('[data-test="stat-failed"]');
    expect(failedCard.classes()).toContain('cursor-pointer');
    expect(failedCard.find('.text-red-500').exists()).toBe(true);
    await wrapper.find('[data-test="stat-failed"]').trigger('click');
    expect(push).toHaveBeenCalledWith('/tasks');
    wrapper.unmount();
  });

  it('点击员工卡 → router.push 下钻 /employees/:id', async () => {
    mockedApi.listEmployees.mockResolvedValue(EMPS);
    mockTasks();
    mockedApi.listChecks.mockResolvedValue([]);
    const { wrapper, router } = await mountDash([
      { path: '/', component: Dashboard },
      { path: '/employees/:id', component: { template: '<div />' } },
    ]);
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined as never);
    await flushPromises();

    await wrapper.find('[data-test="employee-emp-01"]').trigger('click');
    expect(push).toHaveBeenCalledWith('/employees/emp-01');
    wrapper.unmount();
  });
});
