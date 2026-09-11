import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import Capabilities from '../src/views/Capabilities.vue';
import { api } from '../src/api.js';
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
    listCapabilities: vi.fn(),
    createCapability: vi.fn(),
    updateCapability: vi.fn(),
    deleteCapability: vi.fn(),
    capabilityMeta: vi.fn(),
    listMcpServers: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

import { ElMessage, ElMessageBox } from 'element-plus';
import type { CapabilityDef } from '../src/api.js';

const mockedApi = vi.mocked(api, true);
const mockedMsg = vi.mocked(ElMessage, true);
const mockedBox = vi.mocked(ElMessageBox, true);

const CAPS: CapabilityDef[] = [
  { kind: 'dev', name: '开发编码', description: '阅读、编写代码', tools: { builtin: ['bash', 'files'], mcp: [] }, enabled: true },
  { kind: 'commit', name: '代码提交', tools: { builtin: ['files'], mcp: ['forge'] }, enabled: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedBox.confirm.mockResolvedValue(true as never);
  mockedApi.listCapabilities.mockResolvedValue(CAPS);
  // meta/mcp-servers 缺省：meta 回退内置包、无 MCP server 注册（空清单不渲染卡片）
  mockedApi.capabilityMeta.mockResolvedValue({ builtin: ['bash', 'files'], mcp: ['forge', 'deploy'] } as never);
  mockedApi.listMcpServers.mockResolvedValue([] as never);
});

describe('Capabilities 能力管理页（2026-09-05）', () => {
  it('渲染能力表格：kind/名称/工具来源徽标（builtin 与 mcp 区分）', async () => {
    const wrapper = mountWithEP(Capabilities);
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('开发编码');
    expect(text).toContain('阅读、编写代码');
    expect(wrapper.find('[data-test="builtin-tag-dev-bash"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="mcp-tag-commit-forge"]').text()).toBe('mcp:forge');
  });

  it('关键词过滤能力列表（kind/说明，2026-09-06）', async () => {
    const wrapper = mountWithEP(Capabilities);
    await flushPromises();

    await wrapper.find('[data-test="capabilities-search"]').setValue('commit');
    let rows = wrapper.findAll('[data-test="cap-table"] .el-table__row');
    expect(rows.length).toBe(1);
    expect(rows[0]!.text()).toContain('代码提交');

    await wrapper.find('[data-test="capabilities-search"]').setValue('阅读'); // 说明匹配
    rows = wrapper.findAll('[data-test="cap-table"] .el-table__row');
    expect(rows.length).toBe(1);
    expect(rows[0]!.text()).toContain('dev');
    wrapper.unmount();
  });

  it('启停开关：change → updateCapability 整行提交（enabled 翻转）', async () => {
    const wrapper = mountWithEP(Capabilities);
    await flushPromises();

    await wrapper.find('[data-test="enable-switch-dev"]').find('.el-switch__core').trigger('click');
    await flushPromises();

    expect(mockedApi.updateCapability).toHaveBeenCalledWith('dev', { ...CAPS[0], enabled: false });
  });

  it('删除：confirm 后调 deleteCapability 并刷新列表', async () => {
    mockedApi.deleteCapability.mockResolvedValue({ kind: 'commit' } as never);
    const wrapper = mountWithEP(Capabilities);
    await flushPromises();

    const row = wrapper.findAll('[data-test="cap-table"] .el-table__row')[1]!;
    await row.find('[data-test="delete-btn"]').trigger('click');
    await flushPromises();

    expect(mockedBox.confirm).toHaveBeenCalled();
    expect(mockedApi.deleteCapability).toHaveBeenCalledWith('commit');
    expect(mockedApi.listCapabilities).toHaveBeenCalledTimes(2); // 初始 + 刷新
  });

  it('新增能力：对话框填写 kind/name/工具来源 → createCapability（POST 201）', async () => {
    mockedApi.createCapability.mockResolvedValue({ kind: 'test' } as never);
    const wrapper = mountWithEP(Capabilities);
    await flushPromises();

    await wrapper.find('[data-test="create-btn"]').trigger('click');
    await wrapper.find('[data-test="d-kind"]').setValue('test');
    await wrapper.find('[data-test="d-name"]').setValue('测试验证');
    // 工具来源多选：勾选 builtin=bash（checkbox 原生 input 走 setValue 触发 change）
    await wrapper.find('[data-test="d-builtin"] input').setValue(true);
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();

    expect(mockedApi.createCapability).toHaveBeenCalledWith({
      kind: 'test', name: '测试验证', description: '', enabled: true,
      tools: { builtin: ['bash'], mcp: [] },
    });
    expect(mockedMsg.success).toHaveBeenCalled();
  });

  it('保存失败：后端 400 message 原样经 ElMessage.error 展示', async () => {
    mockedApi.createCapability.mockRejectedValue(new Error('能力 tools.builtin 含未知内置能力: shell（允许: bash, files）'));
    const wrapper = mountWithEP(Capabilities);
    await flushPromises();

    await wrapper.find('[data-test="create-btn"]').trigger('click');
    await wrapper.find('[data-test="d-kind"]').setValue('bad');
    await wrapper.find('[data-test="d-name"]').setValue('坏能力');
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();

    expect(mockedMsg.error).toHaveBeenCalledWith('能力 tools.builtin 含未知内置能力: shell（允许: bash, files）');
  });

  it('删除不存在的能力：404 message 原样经 ElMessage.error 展示', async () => {
    mockedApi.deleteCapability.mockRejectedValue(new Error('能力不存在: commit'));
    const wrapper = mountWithEP(Capabilities);
    await flushPromises();

    const row = wrapper.findAll('[data-test="cap-table"] .el-table__row')[1]!;
    await row.find('[data-test="delete-btn"]').trigger('click');
    await flushPromises();

    expect(mockedMsg.error).toHaveBeenCalledWith('能力不存在: commit');
  });
});

describe('能力工具来源服务端化 + MCP server 展示（2026-09-06 用户需求 A+B）', () => {
  it('下拉选项从 /api/capabilities/meta 拉取：mcp 含已注册 MCP server 名', async () => {
    mockedApi.capabilityMeta.mockResolvedValue({
      builtin: ['bash', 'files', 'python'],
      mcp: ['forge', 'deploy', 'gitlab-mcp'],
    } as never);
    const wrapper = mountWithEP(Capabilities);
    await flushPromises();

    // 打开新增对话框：checkbox 选项 = meta 下发的清单（server 名即工具包标识）
    await wrapper.find('[data-test="create-btn"]').trigger('click');
    await flushPromises();
    const boxes = wrapper.find('[data-test="d-mcp"]');
    expect(boxes.exists()).toBe(true);
    const text = boxes.text();
    expect(text).toContain('gitlab-mcp');
    expect(text).toContain('forge');
    const builtins = wrapper.find('[data-test="d-builtin"]').text();
    expect(builtins).toContain('python');
  });

  it('meta 拉取失败回退内置常量（不阻塞主表渲染）', async () => {
    mockedApi.capabilityMeta.mockRejectedValue(new Error('network down'));
    const wrapper = mountWithEP(Capabilities);
    await flushPromises();
    expect(wrapper.text()).toContain('开发编码'); // 主表照常
    await wrapper.find('[data-test="create-btn"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="d-mcp"]').text()).toContain('deploy');
  });

  it('MCP server 状态卡：有注册 server 时展示连接状态与工具数；空清单不渲染', async () => {
    mockedApi.listMcpServers.mockResolvedValue([
      { name: 'gitlab-mcp', status: 'connected', tools: ['mcp_gitlab-mcp_ping', 'mcp_gitlab-mcp_mr'] },
      { name: 'ci-mcp', status: 'error', error: 'connection refused', tools: [] },
    ] as never);
    const wrapper = mountWithEP(Capabilities);
    await flushPromises();
    expect(wrapper.find('[data-test="mcp-servers"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="mcp-server-gitlab-mcp"]').text()).toContain('已连接');
    expect(wrapper.find('[data-test="mcp-server-gitlab-mcp"]').text()).toContain('2 个工具');
    expect(wrapper.find('[data-test="mcp-server-ci-mcp"]').text()).toContain('连接失败');
    expect(wrapper.find('[data-test="mcp-server-ci-mcp"]').text()).toContain('connection refused');
  });

  it('无 MCP server 注册：状态卡不渲染（空注册表是正常态）', async () => {
    const wrapper = mountWithEP(Capabilities);
    await flushPromises();
    expect(wrapper.find('[data-test="mcp-servers"]').exists()).toBe(false);
  });
});
