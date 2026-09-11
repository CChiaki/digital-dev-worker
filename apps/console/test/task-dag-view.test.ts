import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import TaskDagView from '../src/views/TaskDagView.vue';
import { api } from '../src/api.js';
import { makeTestRouter, mountWithRouter } from './mount-helper.js';

/**
 * 编排视图独立页面（2026-09-08 用户反馈：弹窗效果差 → 独立页面 /tasks/dag）。
 * 页面承载：返回按钮 + 页头惯例、全量任务 DAG 拓扑分层、blocked 徽标、点卡片进详情、
 * 直接 URL 访问可用（mount 即在 /tasks/dag 上验证）。
 */

vi.mock('../src/api.js', () => ({
  api: {
    listTasks: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

beforeEach(() => {
  vi.clearAllMocks();
});

function mountDagView() {
  const router = makeTestRouter([
    { path: '/tasks/dag', component: TaskDagView },
    { path: '/tasks/:id', component: { template: '<div data-test="detail-stub" />' } },
    { path: '/tasks', component: { template: '<div data-test="center-stub" />' } },
  ]);
  return mountWithRouter(TaskDagView, { router, path: '/tasks/dag' }).then((wrapper) => ({ wrapper, router }));
}

describe('TaskDagView 编排视图独立页面', () => {
  it('页头惯例：返回按钮 + 「编排视图」标题；直接 URL 访问即渲染 DAG 全量分层', async () => {
    mockedApi.listTasks.mockResolvedValue([
      { taskId: 'TASK-A', title: '底座任务', status: 'done', hasResult: true },
      { taskId: 'TASK-B', title: '下游任务', status: 'pending', hasResult: false, dependsOn: ['TASK-A'], depsState: 'ready' },
    ] as never);
    const { wrapper } = await mountDagView();
    await flushPromises();

    expect(wrapper.find('[data-test="back-btn"]').exists()).toBe(true);
    expect(wrapper.find('h2').text()).toBe('编排视图');
    // 全量任务（不随检索过滤）按拓扑分层：A 第 1 层、B 第 2 层
    expect(wrapper.find('[data-test="dag"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-test="dag-level"]')).toHaveLength(2);
    expect(wrapper.find('[data-test="dag-card-TASK-A"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="dag-card-TASK-B"]').text()).toContain('依赖 TASK-A');
  });

  it('blocked 依赖阻断红徽标在页面可见', async () => {
    mockedApi.listTasks.mockResolvedValue([
      { taskId: 'TASK-A', title: '失败上游', status: 'failed', hasResult: false },
      { taskId: 'TASK-B', title: '被阻断', status: 'pending', hasResult: false, dependsOn: ['TASK-A'], depsState: 'blocked' },
    ] as never);
    const { wrapper } = await mountDagView();
    await flushPromises();

    expect(wrapper.find('[data-test="deps-blocked"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="deps-blocked"]').text()).toBe('依赖阻断');
  });

  it('点击卡片 router.push 进任务详情（数据源与跳转保持弹窗版行为）', async () => {
    mockedApi.listTasks.mockResolvedValue([
      { taskId: 'TASK-A', title: '底座任务', status: 'done', hasResult: true },
      { taskId: 'TASK-B', title: '下游任务', status: 'pending', hasResult: false, dependsOn: ['TASK-A'] },
    ] as never);
    const { wrapper, router } = await mountDagView();
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined as never);
    await flushPromises();

    await wrapper.find('[data-test="dag-card-TASK-B"]').trigger('click');
    expect(push).toHaveBeenCalledWith('/tasks/TASK-B');
  });

  it('空任务列表：空态引导，不渲染 DAG', async () => {
    mockedApi.listTasks.mockResolvedValue([] as never);
    const { wrapper } = await mountDagView();
    await flushPromises();

    expect(wrapper.find('[data-test="dag"]').exists()).toBe(false);
    expect(wrapper.find('.el-empty').exists()).toBe(true);
  });

  it('加载失败：错误信息可见（不留空态误导）', async () => {
    mockedApi.listTasks.mockRejectedValue(new Error('网络不可用'));
    const { wrapper } = await mountDagView();
    await flushPromises();

    expect(wrapper.find('[data-test="error"]').text()).toContain('网络不可用');
    expect(wrapper.find('[data-test="dag"]').exists()).toBe(false);
    expect(wrapper.find('.el-empty').exists()).toBe(false);
  });
});
