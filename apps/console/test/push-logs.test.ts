import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import PushLogs from '../src/views/PushLogs.vue';
import { api } from '../src/api.js';
import { mountWithEP } from './mount-helper.js';

vi.mock('../src/api.js', () => ({
  api: {
    listPushLogs: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

const mockedApi = vi.mocked(api, true);

beforeEach(() => {
  vi.clearAllMocks();
});

/** 种子：成功两条（燕讯带流水号）+ 失败一条 */
function stubLogs() {
  mockedApi.listPushLogs.mockResolvedValue([
    { id: 'p1', messageId: 'm1', taskId: 'TASK-A', messageTitle: '任务 TASK-A 待人工放行', channelId: 'y1', channelType: 'yanxun', channelName: '燕讯', status: 'sent', yanxunSeqNo: 'R0251202609111530010123456789abcdef', createdAt: Date.now() },
    { id: 'p2', messageId: 'm2', taskId: 'TASK-A', messageTitle: '任务 TASK-A 执行失败', channelId: 'd1', channelType: 'dingtalk', channelName: '钉钉', status: 'sent', createdAt: Date.now() },
    { id: 'p3', messageId: 'm3', taskId: 'TASK-B', messageTitle: '任务 TASK-B 执行失败', channelId: 'y1', channelType: 'yanxun', channelName: '燕讯', status: 'failed', error: '渠道 燕讯 推送失败: 燕讯返回 999992（ip 不在白名单）', createdAt: Date.now() },
  ]);
}

describe('PushLogs 推送记录（2026-09-10）', () => {
  function rows(wrapper: ReturnType<typeof mountWithEP>) {
    return wrapper.findAll('[data-test="push-table"] .el-table__row');
  }

  it('渲染全量记录：时间/消息/渠道/状态/流水号/失败原因', async () => {
    stubLogs();
    const wrapper = mountWithEP(PushLogs);
    await flushPromises();
    expect(rows(wrapper).length).toBe(3);
    expect(rows(wrapper)[0]!.text()).toContain('燕讯');
    expect(rows(wrapper)[0]!.text()).toContain('R0251202609111530010123456789abcdef'); // 流水号留痕可见
    expect(rows(wrapper)[2]!.text()).toContain('ip 不在白名单');
    expect(rows(wrapper)[0]!.find('[data-test="push-status"]').text()).toBe('已推送');
  });

  it('状态过滤：只看失败 / 只看成功', async () => {
    stubLogs();
    const wrapper = mountWithEP(PushLogs);
    await flushPromises();

    // 切「推送失败」（radio input setValue，live-audit 同款）
    const failed = wrapper.findAll('[data-test="push-status-filter"] input')
      .find((i) => (i.element as HTMLInputElement).value === 'failed')!;
    await failed.setValue(true);
    await flushPromises();
    expect(rows(wrapper).length).toBe(1);
    expect(rows(wrapper)[0]!.text()).toContain('TASK-B');

    const sent = wrapper.findAll('[data-test="push-status-filter"] input')
      .find((i) => (i.element as HTMLInputElement).value === 'sent')!;
    await sent.setValue(true);
    await flushPromises();
    expect(rows(wrapper).length).toBe(2);
  });

  it('关键词过滤：任务 ID / 渠道名 / 流水号', async () => {
    stubLogs();
    const wrapper = mountWithEP(PushLogs);
    await flushPromises();

    await wrapper.find('[data-test="push-search"]').setValue('task-b');
    expect(rows(wrapper).length).toBe(1);

    await wrapper.find('[data-test="push-search"]').setValue('钉钉');
    expect(rows(wrapper).length).toBe(1);

    await wrapper.find('[data-test="push-search"]').setValue('R025120260911');
    expect(rows(wrapper).length).toBe(1);

    await wrapper.find('[data-test="push-search"]').setValue('不存在');
    expect(wrapper.text()).toContain('暂无推送记录');
  });

  it('空记录空态 + 请求失败错误提示', async () => {
    mockedApi.listPushLogs.mockResolvedValue([]);
    let wrapper = mountWithEP(PushLogs);
    await flushPromises();
    expect(wrapper.text()).toContain('暂无推送记录');

    mockedApi.listPushLogs.mockRejectedValue(new Error('未启用推送留痕'));
    wrapper = mountWithEP(PushLogs);
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('未启用推送留痕');
  });
});
