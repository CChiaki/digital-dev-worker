import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import CheckReview from '../src/views/CheckReview.vue';
import { api } from '../src/api.js';
import { mountWithEP } from './mount-helper.js';

vi.mock('../src/api.js', () => ({
  api: {
    listCheckHistory: vi.fn(),
    reviewCheck: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

const mockedApi = vi.mocked(api, true);

beforeEach(() => {
  vi.clearAllMocks();
});

/** 全量记录种子（2026-09-10 默认待办 + 过滤全部）：待审两条 + 已放行/已驳回/已失效各一条 */
function stubHistory() {
  mockedApi.listCheckHistory.mockResolvedValue([
    { taskId: 'TASK-A', item: 'T-1', result: '构建通过，3 断言全绿', checkTs: 1, pending: true },
    { taskId: 'TASK-B', item: 'T-2', result: '覆盖率 82%，边界用例待补', checkTs: 2, pending: true },
    { taskId: 'TASK-C', item: 'bash-1', result: 'rm apps/console/test/__probe.test.ts', bash: true, checkTs: 3, pending: false, approved: true, comment: '放行清理', verdictTs: 4 },
    { taskId: 'TASK-D', item: 'T-4', result: '自测未过', checkTs: 5, pending: false, approved: false, comment: '边界没覆盖', verdictTs: 6 },
    { taskId: 'TASK-E', item: 'bash-2', result: 'docker ps', bash: true, checkTs: 7, pending: true, expired: true },
  ]);
}

describe('CheckReview 人工放行（默认待办 + 过滤全部记录）', () => {
  /** el-table 行：jsdom 下直接查 .el-table__row（task-center.test.ts 同款用法） */
  function rows(wrapper: ReturnType<typeof mountWithEP>) {
    return wrapper.findAll('[data-test="check-table"] .el-table__row');
  }

  it('默认待办视图：只渲染待审（不含已裁决/已失效）', async () => {
    stubHistory();
    const wrapper = mountWithEP(CheckReview);
    await flushPromises();
    const tableRows = rows(wrapper);
    expect(tableRows.length).toBe(2);
    expect(tableRows[0]!.text()).toContain('TASK-A');
    expect(tableRows[0]!.find('[data-test="item"]').text()).toBe('T-1');
    expect(tableRows[0]!.text()).toContain('构建通过');
    // 行钩子：check-{taskId}-{item} 落在任务 ID 单元格
    expect(tableRows[0]!.find('[data-test="check-TASK-A-T-1"]').exists()).toBe(true);
    expect(tableRows[1]!.find('[data-test="check-TASK-B-T-2"]').exists()).toBe(true);
    // 已裁决/已失效不出现在待办视图
    expect(wrapper.find('[data-test="check-TASK-C-bash-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="check-TASK-E-bash-2"]').exists()).toBe(false);
    // 待办视图无状态/时间列
    expect(wrapper.find('[data-test="check-status"]').exists()).toBe(false);
  });

  /** 切视图到「全部记录」（el-radio-button label click 在 jsdom 不联动，直接对 radio input setValue） */
  async function switchToAll(wrapper: ReturnType<typeof mountWithEP>) {
    const target = wrapper.findAll('[data-test="check-scope"] input')
      .find((i) => (i.element as HTMLInputElement).value === 'all')!;
    await target.setValue(true);
    await flushPromises();
  }

  it('切「全部记录」：含历史裁决与已失效，状态标签 + 意见 + 时间', async () => {
    stubHistory();
    const wrapper = mountWithEP(CheckReview);
    await flushPromises();
    await switchToAll(wrapper);

    const tableRows = rows(wrapper);
    expect(tableRows.length).toBe(5); // 全量（种子顺序即展示顺序，后端负责 checkTs 倒序）
    // bash 放行带（命令）标记
    expect(tableRows[2]!.find('[data-test="item"]').text()).toContain('bash-1（命令）');
    // 状态标签：待审/待审/已放行/已驳回/已失效
    const statuses = tableRows.map((r) => r.find('[data-test="check-status"]').text());
    expect(statuses).toEqual(['待审', '待审', '已放行', '已驳回', '已失效']);
    // 裁决意见列
    expect(tableRows[2]!.text()).toContain('放行清理');
    expect(tableRows[3]!.text()).toContain('边界没覆盖');
  });

  it('检索区按任务关键词过滤表格行', async () => {
    stubHistory();
    const wrapper = mountWithEP(CheckReview);
    await flushPromises();
    expect(rows(wrapper).length).toBe(2);

    await wrapper.find('[data-test="check-search"]').setValue('TASK-A');
    expect(rows(wrapper)).toHaveLength(1);
    expect(wrapper.find('[data-test="check-TASK-B-T-2"]').exists()).toBe(false);

    // 关键词大小写不敏感
    await wrapper.find('[data-test="check-search"]').setValue('task-b');
    expect(rows(wrapper)).toHaveLength(1);
    expect(wrapper.find('[data-test="check-TASK-B-T-2"]').exists()).toBe(true);

    // 无匹配 → 表格空态文案
    await wrapper.find('[data-test="check-search"]').setValue('不存在的任务');
    expect(wrapper.text()).toContain('暂无待审节点');
  });

  it('matches 纯函数（defineExpose）：空关键词=全部，非空按 taskId 过滤', async () => {
    stubHistory();
    const wrapper = mountWithEP(CheckReview);
    await flushPromises();
    const { matches } = wrapper.vm as unknown as {
      matches: (c: { taskId: string }) => boolean;
    };
    expect(matches({ taskId: 'TASK-A' })).toBe(true); // 空关键词 = 全部
    await wrapper.find('[data-test="check-search"]').setValue('TASK-A');
    expect(matches({ taskId: 'TASK-A' })).toBe(true);
    expect(matches({ taskId: 'TASK-B' })).toBe(false);
  });

  it('放行：行内按钮 → reviewCheck(taskId, item, true) 并刷新', async () => {
    stubHistory();
    mockedApi.reviewCheck.mockResolvedValue({ taskId: 'TASK-A', item: 'T-1', approved: true });
    const wrapper = mountWithEP(CheckReview);
    await flushPromises();

    await rows(wrapper)[0]!.find('[data-test="approve-btn"]').trigger('click');
    await flushPromises();
    expect(mockedApi.reviewCheck).toHaveBeenCalledWith('TASK-A', 'T-1', true, undefined);
    expect(mockedApi.listCheckHistory).toHaveBeenCalledTimes(2); // 初始 + 复核后刷新
    expect(wrapper.find('[data-test="message"]').text()).toContain('已放行');
  });

  it('驳回：行内填意见确认 → reviewCheck(..., false, 意见)', async () => {
    stubHistory();
    mockedApi.reviewCheck.mockResolvedValue({ taskId: 'TASK-A', item: 'T-1', approved: false });
    const wrapper = mountWithEP(CheckReview);
    await flushPromises();

    await rows(wrapper)[0]!.find('[data-test="reject-btn"]').trigger('click');
    await wrapper.find('[data-test="comment-input"]').setValue('边界用例没覆盖');
    await wrapper.find('[data-test="confirm-reject-btn"]').trigger('click');
    await flushPromises();
    expect(mockedApi.reviewCheck).toHaveBeenCalledWith('TASK-A', 'T-1', false, '边界用例没覆盖');
    expect(wrapper.find('[data-test="message"]').text()).toContain('已驳回');
  });

  it('放行失败展示错误信息', async () => {
    stubHistory();
    mockedApi.reviewCheck.mockRejectedValue(new Error('该节点已非待审状态'));
    const wrapper = mountWithEP(CheckReview);
    await flushPromises();

    await rows(wrapper)[0]!.find('[data-test="approve-btn"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('已非待审状态');
  });

  it('无待审时提示空态；全部视图无记录另有文案', async () => {
    mockedApi.listCheckHistory.mockResolvedValue([]);
    const wrapper = mountWithEP(CheckReview);
    await flushPromises();
    expect(wrapper.text()).toContain('暂无待审节点');

    await switchToAll(wrapper);
    expect(wrapper.text()).toContain('暂无放行记录');
  });
});
