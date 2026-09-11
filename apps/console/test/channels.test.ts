import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import Channels from '../src/views/Channels.vue';
import { api, type NotificationChannelView } from '../src/api.js';
import { mountWithEP } from './mount-helper.js';

// ElMessage / ElMessageBox 打桩：success/error 断言提示文案；confirm 默认放行
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    ElMessageBox: { confirm: vi.fn().mockResolvedValue(true) },
  };
});

vi.mock('../src/api.js', () => ({
  api: {
    listChannels: vi.fn(),
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    deleteChannel: vi.fn(),
    testChannel: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

import { ElMessage, ElMessageBox } from 'element-plus';

const mockedApi = vi.mocked(api, true);
const mockedMsg = vi.mocked(ElMessage, true);
const mockedBox = vi.mocked(ElMessageBox, true);

const CHANNELS: NotificationChannelView[] = [
  { id: 'ch-1', type: 'dingtalk', name: '值班群', webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc123', secret: 'SECxxx', enabled: true },
  { id: 'ch-2', type: 'wecom', name: '项目群', webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xyz789', enabled: false },
  { id: 'ch-3', type: 'webhook', name: '外部平台', webhookUrl: 'https://hooks.example.com/aaa', enabled: true },
  { id: 'ch-4', type: 'yanxun', name: '内部群', webhookUrl: '', token: '27ff8845f9731cad813350af43f56d00a7f8bdc27bb1204f2402c648845b3aa2', enabled: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedBox.confirm.mockResolvedValue(true as never);
  mockedApi.listChannels.mockResolvedValue(CHANNELS);
  mockedApi.testChannel.mockResolvedValue({ id: 'ch-1', sent: true });
});

describe('Channels 通知渠道页（Task 10）', () => {
  it('渲染渠道表格：类型 tag（钉钉/企微/Webhook/燕讯）、名称、URL/Token 脱敏', async () => {
    const wrapper = mountWithEP(Channels);
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('值班群');
    expect(text).toContain('项目群');
    expect(text).toContain('外部平台');
    expect(text).toContain('内部群');
    expect(wrapper.find('[data-test="type-tag-ch-1"]').text()).toBe('钉钉');
    expect(wrapper.find('[data-test="type-tag-ch-2"]').text()).toBe('企微');
    expect(wrapper.find('[data-test="type-tag-ch-3"]').text()).toBe('Webhook');
    expect(wrapper.find('[data-test="type-tag-ch-4"]').text()).toBe('燕讯');
    expect(text).toContain('oapi.dingtalk.com/***');
    expect(text).toContain('qyapi.weixin.qq.com/***');
    expect(text).not.toContain('access_token=abc123');
    // 燕讯 token 脱敏：只显示前 8 位
    expect(text).toContain('27ff8845***');
    expect(text).not.toContain('7f8bdc27bb1204f');
  });

  it('关键词过滤渠道列表（名称，2026-09-06）', async () => {
    const wrapper = mountWithEP(Channels);
    await flushPromises();

    await wrapper.find('[data-test="channels-search"]').setValue('项目群');
    const rows = wrapper.findAll('[data-test="channel-table"] .el-table__row');
    expect(rows.length).toBe(1);
    expect(rows[0]!.text()).toContain('项目群');
    wrapper.unmount();
  });

  it('启停开关：change → updateChannel 整行提交（enabled 翻转）', async () => {
    const wrapper = mountWithEP(Channels);
    await flushPromises();

    await wrapper.find('[data-test="enable-switch-ch-1"]').find('.el-switch__core').trigger('click');
    await flushPromises();

    expect(mockedApi.updateChannel).toHaveBeenCalledWith('ch-1', { ...CHANNELS[0], enabled: false });
  });

  it('「发送测试」：loading 态 → testChannel；失败（502 不可达）经 ElMessage.error 原样提示', async () => {
    let resolveTest!: (v: { id: string; sent: boolean }) => void;
    mockedApi.testChannel.mockImplementation(() => new Promise((r) => (resolveTest = r)));
    const wrapper = mountWithEP(Channels);
    await flushPromises();

    const btn = wrapper.find('[data-test="test-btn-ch-1"]');
    await btn.trigger('click');
    await flushPromises();
    expect(mockedApi.testChannel).toHaveBeenCalledWith('ch-1');
    expect(btn.classes()).toContain('is-loading'); // 请求未返回时 loading

    resolveTest({ id: 'ch-1', sent: true });
    await flushPromises();
    expect(wrapper.find('[data-test="test-btn-ch-1"]').classes()).not.toContain('is-loading');
    expect(mockedMsg.success).toHaveBeenCalled();

    mockedApi.testChannel.mockRejectedValueOnce(new Error('渠道不可达: connect ECONNREFUSED'));
    await wrapper.find('[data-test="test-btn-ch-1"]').trigger('click');
    await flushPromises();
    expect(mockedMsg.error).toHaveBeenCalledWith('渠道不可达: connect ECONNREFUSED');
  });

  it('删除：confirm 后调 deleteChannel 并刷新列表；失败原样 ElMessage.error', async () => {
    mockedApi.deleteChannel.mockResolvedValue({ id: 'ch-2' } as never);
    const wrapper = mountWithEP(Channels);
    await flushPromises();

    const row = wrapper.findAll('[data-test="channel-table"] .el-table__row')[1]!;
    await row.find('[data-test="delete-btn"]').trigger('click');
    await flushPromises();

    expect(mockedBox.confirm).toHaveBeenCalled();
    expect(mockedApi.deleteChannel).toHaveBeenCalledWith('ch-2');
    expect(mockedApi.listChannels).toHaveBeenCalledTimes(2); // 初始 + 刷新
    expect(mockedMsg.success).toHaveBeenCalled();
  });

  it('新增渠道：对话框填写类型/名称/URL/secret（钉钉显示）→ createChannel', async () => {
    mockedApi.createChannel.mockResolvedValue({ id: 'ch-new' });
    const wrapper = mountWithEP(Channels);
    await flushPromises();

    await wrapper.find('[data-test="create-btn"]').trigger('click');
    // 默认类型 dingtalk → secret 输入可见
    expect(wrapper.find('[data-test="d-secret"]').exists()).toBe(true);
    await wrapper.find('[data-test="d-name"]').setValue('告警群');
    await wrapper.find('[data-test="d-url"]').setValue('https://oapi.dingtalk.com/robot/send?access_token=new');
    await wrapper.find('[data-test="d-secret"]').setValue('SECnew');
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();

    expect(mockedApi.createChannel).toHaveBeenCalledTimes(1);
    const arg = mockedApi.createChannel.mock.calls[0][0]!;
    expect(arg).toEqual(expect.objectContaining({ type: 'dingtalk', name: '告警群', webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=new', secret: 'SECnew', enabled: true }));
    expect(arg.id).toBeTruthy();
    expect(mockedMsg.success).toHaveBeenCalled();
  });

  it('类型切到 wecom → secret 输入隐藏；类型选项含燕讯（2026-09-10）', async () => {
    const wrapper = mountWithEP(Channels);
    await flushPromises();

    await wrapper.find('[data-test="create-btn"]').trigger('click');
    await wrapper.find('[data-test="d-type"]').trigger('click');
    await flushPromises();
    const options = wrapper.findAll('.el-select-dropdown__item');
    expect(options.map((o) => o.text())).toEqual(['钉钉', '企微', 'Webhook', '燕讯']);
    await options[1]!.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="d-secret"]').exists()).toBe(false);
  });

  it('燕讯类型（2026-09-10）：表单切 access_token 输入（Webhook URL 隐藏）→ createChannel 带 token', async () => {
    mockedApi.createChannel.mockResolvedValue({ id: 'ch-yx' });
    const wrapper = mountWithEP(Channels);
    await flushPromises();

    await wrapper.find('[data-test="create-btn"]').trigger('click');
    await wrapper.find('[data-test="d-type"]').trigger('click');
    await flushPromises();
    const yanxunOpt = wrapper.findAll('.el-select-dropdown__item')[3]!;
    await yanxunOpt.trigger('click');
    await flushPromises();
    // 动态表单：燕讯显示 access_token，隐藏 Webhook URL 与 secret
    expect(wrapper.find('[data-test="d-token"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="d-url"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="d-secret"]').exists()).toBe(false);

    await wrapper.find('[data-test="d-name"]').setValue('燕讯测试群');
    await wrapper.find('[data-test="d-token"]').setValue('tok-new-abc');
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();

    const arg = mockedApi.createChannel.mock.calls[0][0]!;
    expect(arg).toEqual(expect.objectContaining({ type: 'yanxun', name: '燕讯测试群', token: 'tok-new-abc', webhookUrl: '', enabled: true }));
    expect(arg).not.toHaveProperty('secret');
    expect(mockedMsg.success).toHaveBeenCalled();
  });

  it('编辑渠道：回填表单，secret 可改，保存走 updateChannel（id 不变）', async () => {
    mockedApi.updateChannel.mockResolvedValue({ id: 'ch-2' });
    const wrapper = mountWithEP(Channels);
    await flushPromises();

    const row = wrapper.findAll('[data-test="channel-table"] .el-table__row')[1]!;
    await row.find('[data-test="edit-btn"]').trigger('click');
    expect((wrapper.find('[data-test="d-name"]').element as HTMLInputElement).value).toBe('项目群');
    expect(wrapper.find('[data-test="d-secret"]').exists()).toBe(false); // wecom 无 secret
    await wrapper.find('[data-test="d-name"]').setValue('项目群-改');
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();

    expect(mockedApi.updateChannel).toHaveBeenCalledWith('ch-2', { ...CHANNELS[1], name: '项目群-改', secret: '' });
  });
});
