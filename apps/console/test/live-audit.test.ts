import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import EmployeeLive from '../src/views/EmployeeLive.vue';
import AuditLog from '../src/views/AuditLog.vue';
import { api } from '../src/api.js';
import { employeeNameMap } from '../src/employee-names.js';
import type { AgentEvent } from '@ddw/runtime';
import { mountWithEP } from './mount-helper.js';

vi.mock('../src/api.js', () => ({
  api: {
    listEvents: vi.fn(),
    listEmployees: vi.fn(),
    audit: vi.fn(),
    getTask: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

const mockedApi = vi.mocked(api, true);

const ev = (id: string, type: AgentEvent['type'], summary: string, ts: number, employeeId = 'emp-01'): AgentEvent => ({
  id, ts, taskId: 'TASK-1', employeeId, type, summary,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.listEmployees.mockResolvedValue([]); // 默认无名册（纯控制台模式）：回退 URL 指定员工
});

describe('EmployeeLive 员工直播', () => {
  it('按员工加载事件时间线：thinking 气泡 / tool_call 徽章行', async () => {
    mockedApi.listEvents.mockResolvedValue([
      ev('e1', 'thinking', '分析任务简报', 1000),
      ev('e2', 'tool_call', 'gitlab_create_branch', 2000),
      ev('e3', 'error', 'GitLab 500', 3000),
    ]);
    const wrapper = mountWithEP(EmployeeLive, { props: { employeeId: 'emp-01' } });
    await flushPromises();

    expect(mockedApi.listEvents).toHaveBeenCalledWith({ employeeId: 'emp-01' });
    const items = wrapper.findAll('[data-test="event-item"]');
    expect(items.length).toBe(3);
    expect(items[0].classes()).toContain('event-thinking');
    expect(items[1].classes()).toContain('event-tool_call');
    expect(items[2].classes()).toContain('event-error');
    expect(wrapper.text()).toContain('gitlab_create_branch');
  });

  it('轮询：只拉取 since 之后的新事件并追加', async () => {
    vi.useFakeTimers();
    try {
      mockedApi.listEvents
        .mockResolvedValueOnce([ev('e1', 'thinking', '第一条', 1000)])
        .mockResolvedValueOnce([ev('e2', 'tool_call', '第二条', 2000)]);

      mountWithEP(EmployeeLive, { props: { employeeId: 'emp-01' } });
      await vi.advanceTimersByTimeAsync(0); // 首次加载
      expect(mockedApi.listEvents).toHaveBeenLastCalledWith({ employeeId: 'emp-01' });

      await vi.advanceTimersByTimeAsync(2000); // 一个轮询周期
      expect(mockedApi.listEvents).toHaveBeenLastCalledWith({ employeeId: 'emp-01', since: 1000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('轮询去重：since 是 >= 语义，最后一条重复返回时不重复渲染（演示实测踩坑）', async () => {
    vi.useFakeTimers();
    try {
      const e1 = ev('e1', 'thinking', '申报节点', 1000);
      const e2 = ev('e2', 'dispatch', '任务 TASK-DEMO-002-FRONTEND 完成（demo-frontend）', 2000);
      mockedApi.listEvents
        .mockResolvedValueOnce([e1, e2])       // 首次：两条
        .mockResolvedValue([e2, e2, e2]);      // 之后每轮：>= since 都把 e2 拉回来（同 ts 语义）

      const wrapper = mountWithEP(EmployeeLive, { props: { employeeId: 'emp-01' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(wrapper.findAll('[data-test="event-item"]').length).toBe(2);

      await vi.advanceTimersByTimeAsync(2000 * 3); // 三个轮询周期
      // e2 重复返回多次仍只渲染一次——不再刷屏
      expect(wrapper.findAll('[data-test="event-item"]').length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // 发送指示已下线（Task 9 裁定：后端无 steer HTTP 端点，旧 emit('steer') 悬空残留随之移除）
  it('员工切换 tab：名册加载 → 默认第一位 → 点击切到另一名员工并重新拉取（P16 演示实测补齐）', async () => {
    mockedApi.listEmployees.mockResolvedValue([
      { id: 'demo-backend', name: '小数', roles: ['backend'], skills: [], capabilities: [], enabled: true, supervision: 'shadow', busy: true, runningTasks: [] },
      { id: 'demo-frontend', name: '小智', roles: ['frontend'], skills: [], capabilities: [], enabled: true, supervision: 'shadow', busy: false, runningTasks: [] },
    ]);
    mockedApi.listEvents.mockResolvedValue([]);
    const wrapper = mountWithEP(EmployeeLive, { props: { employeeId: 'emp-01' } }); // 不在名册 → 回退名册第一位
    await flushPromises();

    expect(mockedApi.listEvents).toHaveBeenLastCalledWith({ employeeId: 'demo-backend' });
    // 样式迁 Tailwind 后 .tab 类已删：钩子改按员工 tab 的 button 元素定位（行为断言不变）
    const tabs = wrapper.findAll('[data-test="employee-tabs"] button');
    expect(tabs.map((t) => t.text())).toEqual([
      expect.stringContaining('小数'),
      expect.stringContaining('小智'),
    ]);

    await tabs[1].trigger('click');
    await flushPromises();
    expect(mockedApi.listEvents).toHaveBeenLastCalledWith({ employeeId: 'demo-frontend' });
    // 激活态 = 选中员工的 el-button（type=primary → el-button--primary）
    expect(wrapper.find('[data-test="employee-tabs"] .el-button--primary').text()).toContain('小智');
  });
});

describe('AuditLog 审计台账', () => {
  it('倒序事件表 + 计数汇总（element-plus 表格）', async () => {
    mockedApi.audit.mockResolvedValue({
      total: 3,
      byType: { thinking: 1, tool_call: 1, intervention: 1 },
      events: [
        ev('e3', 'intervention', '优先处理 T-1', 3000),
        ev('e2', 'tool_call', 'gitlab_create_branch', 2000),
        ev('e1', 'thinking', '分析任务简报', 1000),
      ],
    });
    const wrapper = mountWithEP(AuditLog);
    await flushPromises();

    expect(wrapper.text()).toContain('展示 3/3 条');
    const rows = wrapper.findAll('.el-table__row'); // el-table 行（data-test 上不了 EP 行元素）
    expect(rows.map((r) => r.text())).toEqual([
      expect.stringContaining('人工复核'),
      expect.stringContaining('gitlab_create_branch'),
      expect.stringContaining('分析任务简报'),
    ]);
    // 分批加载（2026-09-10）：默认首批 200 条，offset 0 起拉
    expect(mockedApi.audit).toHaveBeenCalledWith({ limit: 200, offset: 0 });
  });

  it('type 过滤（2026-09-10 改服务端）：切换 tool_call → 带 type 重新拉取第一批', async () => {
    mockedApi.audit.mockImplementation(async (q?: { type?: string }) => ({
      total: q?.type === 'tool_call' ? 1 : 2,
      byType: { thinking: 1, tool_call: 1 },
      events: q?.type === 'tool_call'
        ? [ev('e2', 'tool_call', 'gitlab_create_branch', 2000)]
        : [ev('e2', 'tool_call', 'gitlab_create_branch', 2000), ev('e1', 'thinking', '分析任务简报', 1000)],
    }));
    const wrapper = mountWithEP(AuditLog);
    await flushPromises();

    // el-radio-button 切换：label click 在 jsdom 不联动内部 radio，直接对 radio input setValue
    const target = wrapper.findAll('[data-test="type-filter"] input')
      .find((i) => (i.element as HTMLInputElement).value === 'tool_call')!;
    await target.setValue(true);
    await flushPromises();
    // 过滤在服务端完成：第二次请求带 type + 分批参数
    expect(mockedApi.audit).toHaveBeenLastCalledWith({ type: 'tool_call', limit: 200, offset: 0 });
    const rows = wrapper.findAll('.el-table__row');
    expect(rows.length).toBe(1);
    expect(rows[0]!.text()).toContain('gitlab_create_branch');
    wrapper.unmount();
  });

  it('分批加载（2026-09-10）：首批 200 条不够时底部出「加载更多」，点击带 offset 再拉一批', async () => {
    const batch = Array.from({ length: 200 }, (_, i) => ev(`a${i}`, 'thinking', `首批-${i}`, i));
    mockedApi.audit.mockImplementation(async (q?: { offset?: number }) => ({
      total: 201,
      byType: { thinking: 201 },
      events: (q?.offset ?? 0) === 0 ? batch : [ev('e-last', 'thinking', '第二批末条', 9999)],
    }));
    const wrapper = mountWithEP(AuditLog);
    await flushPromises();

    expect(wrapper.findAll('.el-table__row').length).toBe(200);
    expect(wrapper.text()).toContain('剩余 1 条');
    await wrapper.find('[data-test="audit-load-more"]').trigger('click');
    await flushPromises();
    expect(mockedApi.audit).toHaveBeenLastCalledWith({ limit: 200, offset: 200 });
    expect(wrapper.findAll('.el-table__row').length).toBe(201);
    // 全部到齐后加载更多按钮消失
    expect(wrapper.find('[data-test="audit-load-more"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('员工列显示姓名：映射命中显示姓名，未命中回退原 id（2026-09-06）', async () => {
    employeeNameMap.value = new Map([['emp-01', '小数']]);
    try {
      mockedApi.audit.mockResolvedValue({
        total: 2,
        byType: { thinking: 2 },
        events: [
          ev('e1', 'thinking', '分析任务简报', 1000, 'emp-01'),
          ev('e2', 'thinking', '整理结论', 2000, 'emp-99'),
        ],
      });
      const wrapper = mountWithEP(AuditLog);
      await flushPromises();

      const rows = wrapper.findAll('.el-table__row');
      expect(rows[0]!.text()).toContain('小数');
      expect(rows[0]!.text()).not.toContain('emp-01');
      // 映射无该 id → 回退显示原 id，不得显示空白
      expect(rows[1]!.text()).toContain('emp-99');
      wrapper.unmount();
    } finally {
      employeeNameMap.value = new Map(); // 还原模块级映射，避免污染后续用例
    }
  });
});
