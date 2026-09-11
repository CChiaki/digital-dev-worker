import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import TaskDetail from '../src/views/TaskDetail.vue';
import { api } from '../src/api.js';
import type { AgentEvent } from '@ddw/runtime';
import type { TaskAudit, TaskDetailRecord } from '../src/api.js';
import { mountWithEP } from './mount-helper.js';

// 本文件 mount 不挂 router 插件，TaskDetail useRouter 直接 mock（返回按钮断言用）
const routerMock = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
vi.mock('vue-router', () => ({ useRouter: () => routerMock }));

vi.mock('../src/api.js', () => ({
  api: {
    getTask: vi.fn(),
    claimTask: vi.fn(),
    resumeTask: vi.fn(),
    listEvents: vi.fn(),
    auditTask: vi.fn(),
    listEmployees: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

const mockedApi = vi.mocked(api, true);

const RECORD: TaskDetailRecord = {
  pkg: {
    taskId: 'TASK-1',
    title: 'sum 修复',
    repo: { url: 'http://gitlab.inner.bank/x.git', branch: 'fix/sum' },
    tasks: [
      { id: 'T-1', title: '修 bug', files: ['src/sum.js'], requirement: '返回 a+b', acceptance: ['自测通过'] },
      { id: 'T-2', title: '联调', files: ['src/api.ts'], requirement: '对接接口', acceptance: ['联调用例通过'] },
    ],
  },
  status: 'running',
};

const check = (id: string, item: string, ts: number, awaiting = false): AgentEvent => ({
  id, ts, taskId: 'TASK-1', employeeId: 'emp-01', type: 'task_check',
  summary: `${item} 节点完成：自测通过`,
  payload: { item, passed: true, result: '自测通过', ...(awaiting ? { awaiting: true } : {}) },
});

const intervention = (id: string, item: string, ts: number, approved: boolean, comment?: string): AgentEvent => ({
  id, ts, taskId: 'TASK-1', employeeId: 'emp-01', type: 'intervention',
  summary: `${approved ? '人工放行' : '人工驳回'}节点 ${item}`,
  payload: { item, approved, ...(comment ? { comment } : {}) },
});

/** listEvents mock：按 type 参数分流（task_check / intervention） */
function mockEvents(list: AgentEvent[]): void {
  mockedApi.listEvents.mockImplementation(async (q) =>
    list.filter((e) => e.type === q?.type) as never,
  );
}

const AUDIT: TaskAudit = {
  task: RECORD,
  timeline: [],
  toolCalls: [
    { name: 'read_file', count: 3, errors: 0 },
    { name: 'run_cmd', count: 2, errors: 1 },
  ],
  reply: '自测通过，已提交 MR',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.getTask.mockResolvedValue(RECORD);
  mockedApi.auditTask.mockResolvedValue(AUDIT);
  mockEvents([]);
});

describe('TaskDetail 节点验收四态（P12-T2）', () => {
  it('无申报 → 待申报；最新申报 awaiting 且无复核 → 待放行', async () => {
    mockEvents([check('c1', 'T-1', 1000, true)]);
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    await flushPromises();

    const t1 = wrapper.find('[data-test="check-item-T-1"]');
    expect(t1.find('[data-test="check-state"]').text()).toBe('待放行');
    expect(t1.text()).toContain('自测通过');
    const t2 = wrapper.find('[data-test="check-item-T-2"]');
    expect(t2.find('[data-test="check-state"]').text()).toBe('待申报');
  });

  it('申报后人工放行 → 已放行；驳回 → 已驳回且意见行内可见', async () => {
    mockEvents([
      check('c1', 'T-1', 1000, true),
      intervention('i1', 'T-1', 2000, false, '边界用例没覆盖'),
      check('c2', 'T-1', 3000, true), // 修正后重报（awaiting）
      intervention('i2', 'T-1', 4000, true),
      check('c3', 'T-2', 5000, true), // T-2 申报后还在等放行
    ]);
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    await flushPromises();

    // T-1：最新一次复核 = 放行（重报后 i2）
    expect(wrapper.find('[data-test="check-item-T-1"] [data-test="check-state"]').text()).toBe('已放行');
    // T-2：最新申报 awaiting、其后无复核
    expect(wrapper.find('[data-test="check-item-T-2"] [data-test="check-state"]').text()).toBe('待放行');
  });

  it('驳回后未重报 → 已驳回 + 驳回意见可见', async () => {
    mockEvents([
      check('c1', 'T-1', 1000, true),
      intervention('i1', 'T-1', 2000, false, '边界用例没覆盖'),
    ]);
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    await flushPromises();

    const item = wrapper.find('[data-test="check-item-T-1"]');
    expect(item.find('[data-test="check-state"]').text()).toBe('已驳回');
    expect(item.find('[data-test="reject-comment"]').text()).toContain('边界用例没覆盖');
  });

  it('旧申报被驳回后重报（无 awaiting 历史）取最新复核状态，不受旧 intervention 影响', async () => {
    // 申报(无 awaiting=assisted 级) → 驳回 → 重报 → 无后续复核：以最新申报为准（无 awaiting → 已放行语义不适用，取待放行兜底为 approved）
    mockEvents([
      check('c1', 'T-1', 1000),
      intervention('i1', 'T-1', 2000, false, 'x'),
      check('c2', 'T-1', 3000),
    ]);
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    await flushPromises();
    // 最新申报 c2 之后无复核 → 非 awaiting → 已放行（assisted 级申报即过）
    expect(wrapper.find('[data-test="check-item-T-1"] [data-test="check-state"]').text()).toBe('已放行');
  });
});

describe('TaskDetail 执行档案', () => {
  it('渲染工具调用统计与最终汇报；audit 失败不阻塞详情', async () => {
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    await flushPromises();

    const tools = wrapper.find('[data-test="tool-calls"]');
    expect(tools.text()).toContain('read_file × 3');
    expect(tools.text()).toContain('run_cmd × 2');
    expect(tools.text()).toContain('1 次错误');
    expect(wrapper.text()).toContain('自测通过，已提交 MR');

    // audit 失败：详情主体仍渲染
    mockedApi.auditTask.mockRejectedValueOnce(new Error('500'));
    const wrapper2 = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    await flushPromises();
    expect(wrapper2.find('[data-test="badge"]').exists()).toBe(true);
    expect(wrapper2.find('[data-test="tool-calls"]').exists()).toBe(false);
  });
});

describe('TaskDetail 返回按钮（2026-09-06）', () => {
  it('返回按钮：history 有上一页 → router.back（2026-09-06）', async () => {
    const orig = Object.getOwnPropertyDescriptor(window.history, 'state');
    Object.defineProperty(window.history, 'state', { value: { back: '/task-center' }, configurable: true, writable: true });
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    try {
      await flushPromises();
      await wrapper.find('[data-test="back-btn"]').trigger('click');
      expect(routerMock.back).toHaveBeenCalled();
    } finally {
      if (orig) Object.defineProperty(window.history, 'state', orig);
      wrapper.unmount();
    }
  });

  it('返回按钮：直链进入无上一页 → 兜底 push(\'/\')（2026-09-08）', async () => {
    const orig = Object.getOwnPropertyDescriptor(window.history, 'state');
    Object.defineProperty(window.history, 'state', { value: null, configurable: true, writable: true });
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    try {
      await flushPromises();
      await wrapper.find('[data-test="back-btn"]').trigger('click');
      expect(routerMock.push).toHaveBeenCalledWith('/');
    } finally {
      if (orig) Object.defineProperty(window.history, 'state', orig);
      wrapper.unmount();
    }
  });
});

describe('TaskDetail 计划进度与续跑（2026-09-05）', () => {
  it('failed + failedItemId：展示计划进度与「从失败项续跑」按钮，点击调 resumeTask 并刷新', async () => {
    mockedApi.getTask.mockResolvedValue({
      ...RECORD,
      status: 'failed',
      planProgress: [
        { itemId: 'T-1', kind: 'dev', title: '修 bug', status: 'done' },
        { itemId: 'T-2', kind: 'commit', title: '联调', status: 'failed' },
      ],
      failedItemId: 'T-2',
    } as TaskDetailRecord);
    mockedApi.resumeTask.mockResolvedValue({ ...RECORD, status: 'pending' });
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    await flushPromises();

    expect(wrapper.text()).toContain('修 bug');
    expect(wrapper.text()).toContain('联调');
    await wrapper.find('[data-test="resume-btn"]').trigger('click');
    await flushPromises();

    expect(mockedApi.resumeTask).toHaveBeenCalledWith('TASK-1');
    expect(mockedApi.getTask).toHaveBeenCalledTimes(2); // 初始 + 续跑后刷新
  });

  it('非 failed 或无停点项：不显示续跑按钮', async () => {
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } }); // status=running，无 planProgress
    await flushPromises();
    expect(wrapper.find('[data-test="resume-btn"]').exists()).toBe(false);
  });
});

describe('TaskDetail 指定员工展示（assignee，2026-09-06）', () => {
  // 注：el-descriptions-item 不透传 attrs（data-test 落不到 DOM），用文本断言
  it('任务包含 assignee：详情展示「指定员工」行；无 assignee 不出该行', async () => {
    mockedApi.getTask.mockResolvedValueOnce({
      ...RECORD,
      pkg: { ...RECORD.pkg, assignee: 'emp-01' },
    } as TaskDetailRecord);
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    await flushPromises();
    expect(wrapper.text()).toContain('指定员工');
    expect(wrapper.text()).toContain('emp-01');
    wrapper.unmount();

    const wrapper2 = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    await flushPromises();
    expect(wrapper2.text()).not.toContain('指定员工');
    wrapper2.unmount();
  });
});

describe('TaskDetail 员工姓名显示（2026-09-06）', () => {
  it('指定员工/领取人行显示姓名；映射无该 id 回退显示原 id', async () => {
    mockedApi.listEmployees.mockResolvedValue([
      { id: 'emp-1', name: '张后端', roles: ['backend'], skills: [], capabilities: [], enabled: true, busy: false, runningTasks: [] },
    ] as never);
    mockedApi.getTask.mockResolvedValueOnce({
      ...RECORD,
      status: 'running',
      claimedBy: 'emp-1',
      pkg: { ...RECORD.pkg, assignee: 'emp-1' },
    } as TaskDetailRecord);
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    await flushPromises();
    expect(wrapper.text()).toContain('张后端');
    expect(wrapper.text()).not.toContain('emp-1');
    wrapper.unmount();

    // 映射无该 id：回退显示原 id，不得显示空白
    mockedApi.getTask.mockResolvedValueOnce({
      ...RECORD,
      status: 'running',
      claimedBy: 'emp-99',
    } as TaskDetailRecord);
    const wrapper2 = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    await flushPromises();
    expect(wrapper2.text()).toContain('emp-99');
    wrapper2.unmount();
  });
});

describe('TaskDetail 轮询（P12-T2）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('5s 轮询刷新；卸载清理定时器', async () => {
    mockedApi.getTask.mockClear();
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-1' } });
    await vi.advanceTimersByTimeAsync(0); // 初始 load
    expect(mockedApi.getTask).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000); // 两个轮询周期
    expect(mockedApi.getTask).toHaveBeenCalledTimes(3);

    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockedApi.getTask).toHaveBeenCalledTimes(3); // 卸载后不再刷新
  });
});
