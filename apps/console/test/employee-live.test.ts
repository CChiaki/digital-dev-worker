import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import EmployeeLive from '../src/views/EmployeeLive.vue';
import { api } from '../src/api.js';
import type { AgentEvent } from '@ddw/runtime';
import { mountWithEP } from './mount-helper.js';

// 本文件 mount 不挂 router 插件，EmployeeLive useRouter 直接 mock（返回按钮断言用）
const routerMock = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
vi.mock('vue-router', () => ({ useRouter: () => routerMock }));

vi.mock('../src/api.js', () => ({
  api: {
    listEvents: vi.fn(),
    listEmployees: vi.fn(),
    getTask: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

const mockedApi = vi.mocked(api, true);

const ev = (
  id: string,
  type: AgentEvent['type'],
  summary: string,
  ts: number,
  payload?: unknown,
  taskId = 'TASK-1',
): AgentEvent => ({ id, ts, taskId, employeeId: 'emp-01', type, summary, payload });

const plan = [
  { id: 'P1', title: '拉取代码', detail: 'clone 仓库', kind: 'dev' },
  { id: 'P2', title: '实现功能', detail: '写代码', kind: 'dev' },
  { id: 'P3', title: '提交验证', detail: '跑测试', kind: 'test' },
];

const planEvent = (phase: 'start' | 'done' | 'failed', itemId?: string, kind?: string) => ({
  plan: { phase, ...(itemId ? { itemId, kind } : {}) },
});

/** P1 已完成（plan 事件 + planProgress 双证）、P2 进行中（仅 start 事件）、P3 待执行（progress skipped） */
const PLAN_EVENTS: AgentEvent[] = [
  ev('e0', 'report', '计划执行：共 3 项', 1000, planEvent('start')),
  ev('e1', 'report', '计划项 1/3 开始：拉取代码', 1100, planEvent('start', 'P1', 'dev')),
  ev('e2', 'tool_call', 'gitlab_create_branch', 1200),
  ev('e3', 'report', '计划项 1/3 完成：拉取代码', 1300, planEvent('done', 'P1')),
  ev('e4', 'report', '计划项 2/3 开始：实现功能', 1400, planEvent('start', 'P2', 'dev')),
  ev('e5', 'tool_call', 'write_file src/app.ts', 1500),
];

const TASK_RECORD = {
  pkg: { taskId: 'TASK-1', title: '示例计划任务', repo: { url: 'git@example.com:r.git', branch: 'main' }, tasks: [], plan },
  status: 'running' as const,
  planProgress: [
    { itemId: 'P1', kind: 'dev', title: '拉取代码', status: 'done' as const },
    { itemId: 'P3', kind: 'test', title: '提交验证', status: 'skipped' as const },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.listEmployees.mockResolvedValue([]);
  mockedApi.listEvents.mockResolvedValue([]);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('EmployeeLive 员工直播（plan 节点分组）', () => {
  it('plan 任务：按计划项分组渲染 3 块，当前项（进行中）默认展开，状态 tag 正确', async () => {
    mockedApi.listEvents.mockResolvedValue(PLAN_EVENTS);
    mockedApi.getTask.mockResolvedValue(TASK_RECORD);
    const wrapper = mountWithEP(EmployeeLive, { props: { employeeId: 'emp-01' } });
    await flushPromises();

    // 选中当前任务并拉取任务详情
    expect(mockedApi.getTask).toHaveBeenCalledWith('TASK-1');
    expect(wrapper.findAll('[data-test^="plan-node-"]').length).toBe(3);

    // 块头：第 N 项 · title + 状态 tag
    const nodes = wrapper.findAll('[data-test^="plan-node-"]');
    expect(nodes[0].text()).toContain('第 1 项 · 拉取代码');
    expect(nodes[0].text()).toContain('已完成');
    expect(nodes[1].text()).toContain('第 2 项 · 实现功能');
    expect(nodes[1].text()).toContain('进行中');
    expect(nodes[2].text()).toContain('第 3 项 · 提交验证');
    expect(nodes[2].text()).toContain('待执行');

    // 当前项（P2 进行中）默认展开：el-collapse-item is-active
    const active = wrapper.find('.el-collapse-item.is-active');
    expect(active.exists()).toBe(true);
    expect(active.text()).toContain('实现功能');
    // 展开块体内是该两项 start 之间的事件（e4 开始 + e5 工具调用）
    const activeItems = active.findAll('[data-test="event-item"]');
    expect(activeItems.length).toBe(2);
    expect(activeItems.map((i) => i.text())).toEqual([
      expect.stringContaining('计划项 2/3 开始'),
      expect.stringContaining('write_file src/app.ts'),
    ]);

    // 归属去重：tool_call 只归属 P2（两次 start 之间），不再落入 P1 块
    const p1 = wrapper.find('[data-test="plan-node-P1"]');
    expect(p1.findAll('[data-test="event-item"]').map((i) => i.text())).toEqual([
      expect.stringContaining('计划执行：共 3 项'),
      expect.stringContaining('计划项 1/3 开始'),
      expect.stringContaining('gitlab_create_branch'),
      expect.stringContaining('计划项 1/3 完成'),
    ]);
  });

  it('老任务包（无 plan）：回退单一时间线，不渲染分组折叠', async () => {
    mockedApi.listEvents.mockResolvedValue([
      ev('e1', 'thinking', '分析任务简报', 1000),
      ev('e2', 'tool_call', 'gitlab_create_branch', 2000),
    ]);
    mockedApi.getTask.mockResolvedValue({
      ...TASK_RECORD,
      pkg: { ...TASK_RECORD.pkg, plan: undefined },
      planProgress: undefined,
    });
    const wrapper = mountWithEP(EmployeeLive, { props: { employeeId: 'emp-01' } });
    await flushPromises();

    expect(wrapper.find('[data-test="plan-nodes"]').exists()).toBe(false);
    const items = wrapper.findAll('[data-test="event-item"]');
    expect(items.length).toBe(2);
    expect(items[0].classes()).toContain('event-thinking');
    expect(items[1].classes()).toContain('event-tool_call');
  });

  it('自动滚动：新事件到达且在底部 → scrollTo 调用；上翻浏览时不打扰', async () => {
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo as unknown as typeof Element.prototype.scrollTo;

    vi.useFakeTimers();
    try {
      mockedApi.listEvents
        .mockResolvedValueOnce([ev('e1', 'thinking', '第一条', 1000)])
        .mockResolvedValueOnce([ev('e2', 'tool_call', '第二条', 2000)])
        .mockResolvedValueOnce([ev('e3', 'tool_call', '第三条', 3000)]);

      const wrapper = mountWithEP(EmployeeLive, { props: { employeeId: 'emp-01' } });
      await vi.advanceTimersByTimeAsync(0); // 首次加载 1 条：默认在底部 → 跟随滚底
      const afterFirst = scrollTo.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);

      // 上翻浏览（nearBottom=false）：新事件到达不滚底
      (wrapper.vm as unknown as { nearBottom: boolean }).nearBottom = false;
      await vi.advanceTimersByTimeAsync(2000);
      expect(scrollTo.mock.calls.length).toBe(afterFirst);

      // 回到底部：恢复跟随
      (wrapper.vm as unknown as { nearBottom: boolean }).nearBottom = true;
      await vi.advanceTimersByTimeAsync(2000);
      expect(scrollTo.mock.calls.length).toBeGreaterThan(afterFirst);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('分组视图滚动：仅当前项切换时 scrollIntoView，同一当前项下新事件到达不重复滚动', async () => {
    const original = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;

    vi.useFakeTimers();
    try {
      mockedApi.getTask.mockResolvedValue(TASK_RECORD);
      mockedApi.listEvents
        .mockResolvedValueOnce(PLAN_EVENTS) // 首次加载：当前项 P2 → 滚动到可见
        .mockResolvedValueOnce([...PLAN_EVENTS, ev('e6', 'tool_call', 'write_file src/b.ts', 1600)]) // 仍属 P2 的新事件
        .mockResolvedValueOnce([
          ...PLAN_EVENTS,
          ev('e6', 'tool_call', 'write_file src/b.ts', 1600),
          ev('e7', 'report', '计划项 2/3 完成：实现功能', 1700, planEvent('done', 'P2')),
          ev('e8', 'report', '计划项 3/3 开始：提交验证', 1800, planEvent('start', 'P3', 'test')),
        ]); // 当前项切换为 P3

      // attachTo：组件内用 document.querySelector 找滚动目标，需真实挂到 document
      const wrapper = mountWithEP(EmployeeLive, { props: { employeeId: 'emp-01' }, attachTo: document.body });
      await vi.advanceTimersByTimeAsync(0); // 首次加载：当前项 P2 默认展开并滚动到可见
      const afterFirst = scrollIntoView.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);

      // 同一当前项（P2）下新事件到达：groupedEvents 重算出新引用，但不重复滚动
      await vi.advanceTimersByTimeAsync(2000);
      expect(scrollIntoView.mock.calls.length).toBe(afterFirst);

      // 当前项切换为 P3：再次滚动
      await vi.advanceTimersByTimeAsync(2000);
      expect(scrollIntoView.mock.calls.length).toBeGreaterThan(afterFirst);
      wrapper.unmount();
    } finally {
      Element.prototype.scrollIntoView = original;
      document.querySelector('[data-test="plan-nodes"]')?.remove();
      vi.useRealTimers();
    }
  });

  it('返回按钮：history 有上一页 → router.back（2026-09-06）', async () => {
    const orig = Object.getOwnPropertyDescriptor(window.history, 'state');
    Object.defineProperty(window.history, 'state', { value: { back: '/task-center' }, configurable: true, writable: true });
    const wrapper = mountWithEP(EmployeeLive, { props: { employeeId: 'emp-01' } });
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
    const wrapper = mountWithEP(EmployeeLive, { props: { employeeId: 'emp-01' } });
    try {
      await flushPromises();
      await wrapper.find('[data-test="back-btn"]').trigger('click');
      expect(routerMock.push).toHaveBeenCalledWith('/');
    } finally {
      if (orig) Object.defineProperty(window.history, 'state', orig);
      wrapper.unmount();
    }
  });

  it('发送指示已下线（后端无 steer HTTP 端点）：不留悬空输入框', async () => {
    const wrapper = mountWithEP(EmployeeLive, { props: { employeeId: 'emp-01' } });
    await flushPromises();

    expect(wrapper.find('[data-test="steer-input"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="steer-send"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('发送指示');
  });
});
