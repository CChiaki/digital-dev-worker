import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import App from '../src/App.vue';
import router from '../src/router';
import { api } from '../src/api.js';
import { mountWithEP } from './mount-helper.js';

// App 壳挂全量路由表：路由懒加载的所有视图共用同一 api mock（各视图按需调用）
vi.mock('../src/api.js', () => ({
  api: {
    listTasks: vi.fn(),
    getTask: vi.fn(),
    createTask: vi.fn(),
    claimTask: vi.fn(),
    finishTask: vi.fn(),
    publishTask: vi.fn(),
    resumeTask: vi.fn(),
    listEvents: vi.fn(),
    audit: vi.fn(),
    auditTask: vi.fn(),
    listEmployees: vi.fn(),
    listChecks: vi.fn(),
    reviewCheck: vi.fn(),
    listCapabilities: vi.fn(),
    createCapability: vi.fn(),
    updateCapability: vi.fn(),
    deleteCapability: vi.fn(),
    // 消息铃铛（Task 10）：顶栏 MessageBell 挂载即轮询
    listMessages: vi.fn(),
    markMessageRead: vi.fn(),
    markAllMessagesRead: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

const mockedApi = vi.mocked(api, true);

const SAMPLE_TASK = {
  pkg: {
    taskId: 'TASK-9',
    title: '登录模块前端重构',
    repo: { url: 'http://gitlab.inner.bank/frontend/web-app.git', branch: 'main' },
    tasks: [],
  },
  status: 'pending' as const,
  hasResult: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.listTasks.mockResolvedValue([]);
  mockedApi.listCapabilities.mockResolvedValue([]);
  mockedApi.listEvents.mockResolvedValue([] as never);
  mockedApi.auditTask.mockResolvedValue({ task: SAMPLE_TASK, timeline: [], toolCalls: [] } as never);
  mockedApi.getTask.mockResolvedValue(SAMPLE_TASK as never);
  mockedApi.listMessages.mockResolvedValue({ messages: [], unread: 0 } as never);
});

describe('AppShell 管理台骨架（vue-router 侧边栏布局）', () => {
  it('侧边栏渲染 9 项导航，/tasks 内容区挂载任务中心', async () => {
    await router.push('/tasks');
    await router.isReady();
    const wrapper = mountWithEP(App, { global: { plugins: [router] } });
    await flushPromises();

    const items = wrapper.findAll('.side-menu .el-menu-item');
    // 推送记录（2026-09-10 用户需求）为第 9 项
    expect(items.map((i) => i.text())).toEqual([
      '首页面板', '任务中心', '数字员工', '人工放行', '审计台账', '能力管理', 'Skill 库', '通知渠道', '推送记录',
    ]);
    expect(wrapper.find('.el-main h2').text()).toBe('任务中心');
    wrapper.unmount();
  });

  it('详情路由 /tasks/:id：taskId 经路由 props 传入，侧边栏高亮任务中心', async () => {
    await router.push('/tasks/TASK-9');
    await router.isReady();
    const wrapper = mountWithEP(App, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.find('.el-main h2').text()).toContain('TASK-9');
    expect(mockedApi.getTask).toHaveBeenCalledWith('TASK-9');
    expect(wrapper.find('.side-menu .el-menu-item.is-active').text()).toContain('任务中心');
    wrapper.unmount();
  });
});
