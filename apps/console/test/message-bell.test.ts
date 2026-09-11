import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import MessageBell from '../src/components/MessageBell.vue';
import { api, type MessageView } from '../src/api.js';
import { mountWithRouter, makeTestRouter } from './mount-helper.js';

// ElNotification 打桩：断言推送新消息弹窗的 title/message/type/onClick
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ElNotification: vi.fn(),
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  };
});

vi.mock('../src/api.js', () => ({
  api: {
    listMessages: vi.fn(),
    markMessageRead: vi.fn(),
    markAllMessagesRead: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

// 推送 mock（2026-09-10 改 SSE 推送不轮询）：unread 由 counts 推送更新；
// 直发消息经 onLiveMessage 注册的回调（测试拿到引用手动触发）
vi.mock('../src/live.js', () => {
  const liveState = { unread: 0, checksPending: 0, skillsPending: 0, connected: true };
  let handler: ((m: MessageView) => void) | undefined;
  return {
    useLiveCounts: () => liveState,
    onLiveMessage: (fn: (m: MessageView) => void) => {
      handler = fn;
      return () => { handler = undefined; };
    },
    __emit: (m: MessageView) => handler?.(m),
    __state: liveState,
  };
});

import { ElNotification, type NotificationOptions } from 'element-plus';
// namespace 导入 + 断言：__emit/__state 是上面 vi.mock 工厂注入的测试辅助，真实模块无此成员
import * as liveModule from '../src/live.js';
const { __emit, __state } = liveModule as unknown as {
  __emit: (m: MessageView) => void;
  __state: { unread: number };
};

const mockedApi = vi.mocked(api, true);
const mockedNotify = vi.mocked(ElNotification, true);

const NOW = Date.now();

const MSGS: MessageView[] = [
  { id: 'm1', type: 'review_required', title: '待放行：TASK-1 计划停点', summary: '第 2 项待人工放行', taskId: 'TASK-1', createdAt: NOW - 60_000 },
  { id: 'm2', type: 'task_failed', title: '任务失败：TASK-2', summary: '构建阶段失败', taskId: 'TASK-2', createdAt: NOW - 2 * 3_600_000 },
  { id: 'm3', type: 'task_done', title: '任务完成：TASK-3', summary: '已回复并归档', taskId: 'TASK-3', readAt: NOW - 1_000, createdAt: NOW - 86_400_000 },
];

async function mountBell() {
  const router = makeTestRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/tasks/:id', name: 'task-detail', props: (r) => ({ taskId: r.params.id }), component: { template: '<div class="task-detail-page" />' } },
  ]);
  await router.push('/'); // memory history 需先完成首次导航，isReady 才就绪
  await router.isReady();
  const wrapper = await mountWithRouter(MessageBell, { router });
  return { wrapper, router };
}

beforeEach(() => {
  vi.clearAllMocks();
  __state.unread = 2;
  mockedApi.listMessages.mockResolvedValue({ messages: MSGS, total: 3, unread: 2 });
  mockedApi.markMessageRead.mockResolvedValue({ id: 'm1', read: true });
  mockedApi.markAllMessagesRead.mockResolvedValue({ marked: 2 });
});

describe('MessageBell 顶栏消息铃铛（2026-09-10 推送 + 过滤分页重设计）', () => {
  it('未读数来自推送 counts（不再轮询）；挂载后不拉列表（开抽屉才拉）', async () => {
    const { wrapper } = await mountBell();
    await flushPromises();

    const badge = wrapper.find('.el-badge__content');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe('2');
    expect(mockedApi.listMessages).not.toHaveBeenCalled(); // 未开抽屉不请求
    wrapper.unmount();
  });

  it('无未读时徽标隐藏', async () => {
    __state.unread = 0;
    const { wrapper } = await mountBell();
    await flushPromises();
    // 0 未读：el-badge hidden → 徽标内容整个不渲染
    expect(wrapper.find('.el-badge__content').exists()).toBe(false);
    wrapper.unmount();
  });

  it('点击铃铛开抽屉：按分页参数拉取（limit 20 / offset 0），类型 tag/标题/摘要/相对时间/未读小圆点', async () => {
    const { wrapper } = await mountBell();
    await flushPromises();

    await wrapper.find('[data-test="bell-btn"]').trigger('click');
    await flushPromises();

    expect(mockedApi.listMessages).toHaveBeenCalledWith({ limit: 20, offset: 0 });
    const text = wrapper.text();
    expect(text).toContain('待放行：TASK-1 计划停点');
    expect(text).toContain('第 2 项待人工放行');
    expect(wrapper.find('[data-test="msg-tag-m1"]').text()).toBe('待放行');
    expect(wrapper.find('[data-test="msg-tag-m2"]').text()).toBe('失败');
    expect(wrapper.find('[data-test="msg-tag-m3"]').text()).toBe('完成');
    expect(text).toContain('1 分钟前');
    // 未读 m1/m2 有小圆点，已读 m3 没有
    expect(wrapper.find('[data-test="unread-dot-m1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="unread-dot-m3"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('单条点击 → markMessageRead → router.push(/tasks/:taskId) → 关抽屉', async () => {
    const { wrapper, router } = await mountBell();
    await flushPromises();
    const pushSpy = vi.spyOn(router, 'push');

    await wrapper.find('[data-test="bell-btn"]').trigger('click');
    await flushPromises();

    await wrapper.find('[data-test="msg-item-m1"]').trigger('click');
    await flushPromises();

    expect(mockedApi.markMessageRead).toHaveBeenCalledWith('m1');
    expect(pushSpy).toHaveBeenCalledWith('/tasks/TASK-1');
    expect(wrapper.find('[data-test="drawer-body"]').isVisible()).toBe(false);
    wrapper.unmount();
  });

  it('「全部已读」→ markAllMessagesRead → 本页消息即时置已读（未读点消失）', async () => {
    const { wrapper } = await mountBell();
    await flushPromises();

    await wrapper.find('[data-test="bell-btn"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="unread-dot-m1"]').exists()).toBe(true);

    await wrapper.find('[data-test="read-all-btn"]').trigger('click');
    await flushPromises();
    expect(mockedApi.markAllMessagesRead).toHaveBeenCalled();
    expect(wrapper.find('[data-test="unread-dot-m1"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('过滤查询：类型下拉 → 带 type 重查；关键词防抖 300ms 后带 q 重查（均回第一页）', async () => {
    vi.useFakeTimers();
    try {
      const { wrapper } = await mountBell();
      await vi.advanceTimersByTimeAsync(0);

      await wrapper.find('[data-test="bell-btn"]').trigger('click');
      await vi.advanceTimersByTimeAsync(0);
      expect(mockedApi.listMessages).toHaveBeenLastCalledWith({ limit: 20, offset: 0 });

      // 类型下拉选「失败」：option 的 value 是类型枚举（TYPE_LABEL 键值对遍历）
      await wrapper.find('[data-test="msg-filter-type"]').trigger('click');
      await vi.advanceTimersByTimeAsync(0);
      await wrapper.find('[data-test="msg-type-option-task_failed"]').trigger('click');
      await vi.advanceTimersByTimeAsync(0);
      expect(mockedApi.listMessages).toHaveBeenLastCalledWith({ type: 'task_failed', limit: 20, offset: 0 });

      // 关键词：300ms 防抖后带 q
      await wrapper.find('[data-test="msg-filter-keyword"]').setValue('TASK-9');
      await vi.advanceTimersByTimeAsync(100);
      expect(mockedApi.listMessages).toHaveBeenCalledTimes(2); // 防抖期内不查
      await vi.advanceTimersByTimeAsync(300);
      expect(mockedApi.listMessages).toHaveBeenLastCalledWith({ type: 'task_failed', q: 'TASK-9', limit: 20, offset: 0 });
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('分页：total > 20 出分页器，翻页带 offset 20', async () => {
    mockedApi.listMessages.mockImplementation(async (q?: { offset?: number }) => ({
      messages: q?.offset ? [] : MSGS,
      total: 25,
      unread: 2,
    }));
    const { wrapper } = await mountBell();
    await flushPromises();

    await wrapper.find('[data-test="bell-btn"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="msg-pagination"]').exists()).toBe(true);

    // EP 分页器第 2 页：pager li 文本 2
    const page2 = wrapper.findAll('[data-test="msg-pagination"] .el-pager li').find((li) => li.text() === '2')!;
    await page2.trigger('click');
    await flushPromises();
    expect(mockedApi.listMessages).toHaveBeenLastCalledWith({ limit: 20, offset: 20 });
    wrapper.unmount();
  });

  it('推送新消息（抽屉关着）→ ElNotification 弹窗直达任务；已推过的 id 不重复弹', async () => {
    const NEW_FAIL: MessageView = { id: 'm9', type: 'task_failed', title: '任务失败：TASK-9', summary: '续跑仍失败', taskId: 'TASK-9', createdAt: NOW };
    const { wrapper, router } = await mountBell();
    await flushPromises();
    const pushSpy = vi.spyOn(router, 'push');
    expect(mockedNotify).not.toHaveBeenCalled();

    __emit(NEW_FAIL);
    await flushPromises();
    expect(mockedNotify).toHaveBeenCalledTimes(1);
    const call = mockedNotify.mock.calls[0]![0] as NotificationOptions;
    expect(call).toEqual(expect.objectContaining({ title: '任务失败：TASK-9', message: '续跑仍失败', type: 'error' }));

    call.onClick?.();
    await flushPromises();
    expect(mockedApi.markMessageRead).toHaveBeenCalledWith('m9');
    expect(pushSpy).toHaveBeenCalledWith('/tasks/TASK-9');

    // 同一条再推（重连等场景）：不重复弹
    __emit(NEW_FAIL);
    await flushPromises();
    expect(mockedNotify).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('抽屉打开期间推送：不弹窗，只刷新列表', async () => {
    const NEW_FAIL: MessageView = { id: 'm9', type: 'task_failed', title: '任务失败：TASK-9', summary: '构建阶段失败', taskId: 'TASK-9', createdAt: NOW };
    const { wrapper } = await mountBell();
    await flushPromises();

    await wrapper.find('[data-test="bell-btn"]').trigger('click');
    await flushPromises();
    const callsBefore = mockedApi.listMessages.mock.calls.length;

    __emit(NEW_FAIL);
    await flushPromises();
    expect(mockedNotify).not.toHaveBeenCalled(); // 开着抽屉不打扰
    expect(mockedApi.listMessages.mock.calls.length).toBe(callsBefore + 1); // 只刷新列表
    wrapper.unmount();
  });
});
