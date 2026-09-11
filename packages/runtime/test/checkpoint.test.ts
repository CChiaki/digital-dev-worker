import { describe, it, expect } from 'vitest';
import { createTaskCheckTool } from '../src/task/checkpoint.js';
import type { AgentEvent, DevTask } from '../src/index.js';

const ITEMS: DevTask[] = [
  { id: 'T-1', title: '修 bug', files: ['src/sum.js'], requirement: '返回 a+b', acceptance: ['node test 通过'] },
  { id: 'T-2', title: '联调', files: ['src/api.ts'], requirement: '对接接口', acceptance: ['联调用例通过'] },
];

const emitted: AgentEvent[] = [];
const deps = {
  emit: async (e: Omit<AgentEvent, 'id' | 'ts' | 'taskId' | 'employeeId'>) => {
    emitted.push({ id: 'x', ts: 1, taskId: 'TK', employeeId: 'emp-01', ...e } as AgentEvent);
  },
};

const tool = () => createTaskCheckTool({ emit: deps.emit, items: ITEMS })[0]!;

describe('task_check 节点申报工具', () => {
  it('正常申报：emit task_check 事件（summary + payload），工具 ok', async () => {
    const r = await tool().execute({ item: 'T-1', result: 'node test 通过，3 断言全绿' });
    expect(r.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('task_check');
    expect(emitted[0]!.summary).toContain('T-1');
    expect(emitted[0]!.summary).toContain('node test 通过');
    expect(emitted[0]!.payload).toEqual({ item: 'T-1', passed: true, result: 'node test 通过，3 断言全绿' });
  });

  it('passed=false 拒绝申报（防误报完成），不 emit', async () => {
    const r = await tool().execute({ item: 'T-1', result: '测试没过', passed: false });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('未通过');
    expect(emitted).toHaveLength(1); // 无新增
  });

  it('item 不在任务包清单 → ok:false 附合法项列表', async () => {
    const r = await tool().execute({ item: 'T-9', result: 'x' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('T-1');
    expect((r as { error: string }).error).toContain('T-2');
  });

  it('缺参数 → ok:false', async () => {
    expect((await tool().execute({ result: 'x' })).ok).toBe(false);
    expect((await tool().execute({})).ok).toBe(false);
  });

  it('不带 items（非任务包执行）也允许申报，仅校验参数', async () => {
    const t = createTaskCheckTool({ emit: deps.emit })[0]!;
    const r = await t.execute({ item: '任意节点', result: 'done' });
    expect(r.ok).toBe(true);
    expect(emitted).toHaveLength(2);
  });
});

describe('task_check 人工放行闸门（P10 盯梢闭环）', () => {
  it('无 gate 行为不变（零回归）：payload 无 awaiting，返回 ok', async () => {
    const emitted: AgentEvent[] = [];
    const t = createTaskCheckTool({ emit: async (e) => { emitted.push({ id: 'x', ts: 1, taskId: 'K', employeeId: 'e', ...e } as AgentEvent); }, items: ITEMS })[0]!;
    const r = await t.execute({ item: 'T-1', result: 'ok' });
    expect(r.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    expect((emitted[0]!.payload as { awaiting?: boolean }).awaiting).toBeUndefined();
  });

  it('有 gate：emit awaiting 事件后阻塞，人工放行 → intervention 留痕 + 工具 ok', async () => {
    const emitted: AgentEvent[] = [];
    // 人工复核 hold 住不放：验证阻塞语义
    let heldResolve: (v: { approved: boolean; comment?: string }) => void = () => {};
    const t = createTaskCheckTool({
      emit: async (e) => { emitted.push({ id: 'x', ts: 1, taskId: 'K', employeeId: 'e', ...e } as AgentEvent); },
      items: ITEMS,
      gate: {
        review: (check) =>
          new Promise<{ approved: boolean; comment?: string }>((resolve) => {
            expect(check.item).toBe('T-1'); // 申报内容透传给人工
            expect(check.result).toBe('构建通过');
            heldResolve = resolve;
          }),
      },
    })[0]!;

    const pending = t.execute({ item: 'T-1', result: '构建通过' });
    await new Promise((r) => setTimeout(r, 10)); // 让 emit 先落
    // 阻塞中：只有 task_check（awaiting: true）一条事件，工具未返回
    expect(emitted).toHaveLength(1);
    expect((emitted[0]!.payload as { awaiting?: boolean }).awaiting).toBe(true);

    heldResolve({ approved: true, comment: 'LGTM' });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.type).toBe('intervention');
    expect(emitted[1]!.summary).toContain('人工放行节点 T-1');
    expect(emitted[1]!.summary).toContain('LGTM');
  });

  it('人工驳回 → intervention 留痕 + 工具 error 带意见（修正后可重复申报）', async () => {
    const emitted: AgentEvent[] = [];
    const t = createTaskCheckTool({
      emit: async (e) => { emitted.push({ id: 'x', ts: 1, taskId: 'K', employeeId: 'e', ...e } as AgentEvent); },
      items: ITEMS,
      gate: {
        review: async () => ({ approved: false, comment: '边界用例没覆盖，补一下' }),
      },
    })[0]!;

    const r = await t.execute({ item: 'T-1', result: '构建通过' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('人工驳回');
    expect((r as { error: string }).error).toContain('边界用例没覆盖');
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.type).toBe('intervention');
    expect(emitted[1]!.summary).toContain('人工驳回节点 T-1');

    // 修正后重新申报（不限制重复申报），这次放行
    const t2 = createTaskCheckTool({
      emit: async (e) => { emitted.push({ id: 'x', ts: 1, taskId: 'K', employeeId: 'e', ...e } as AgentEvent); },
      items: ITEMS,
      gate: { review: async () => ({ approved: true }) },
    })[0]!;
    const r2 = await t2.execute({ item: 'T-1', result: '补齐边界用例后构建通过' });
    expect(r2.ok).toBe(true);
    expect(emitted).toHaveLength(4);
  });
});
