import { describe, it, expect } from 'vitest';
import { CheckReviewQueue, gateForTask, listPendingChecks } from '../src/team/review-gate.js';
import { FileEventStore } from '../src/stores/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@ddw/runtime';

describe('CheckReviewQueue（人工复核队列，P10-T2）', () => {
  it('wait 挂起 → review(approved) 唤醒，闸门放行', async () => {
    const q = new CheckReviewQueue();
    const gate = gateForTask(q, 'TASK-A');
    const pending = gate.review({ item: 'T-1', result: '构建通过', passed: true });
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false); // 阻塞中

    q.review('TASK-A', 'T-1', true, 'LGTM');
    expect(await pending).toEqual({ approved: true, comment: 'LGTM' });
  });

  it('review(approved=false, comment) 唤醒驳回结果', async () => {
    const q = new CheckReviewQueue();
    const gate = gateForTask(q, 'TASK-A');
    const pending = gate.review({ item: 'T-1', result: 'x', passed: true });
    q.review('TASK-A', 'T-1', false, '边界没覆盖');
    expect(await pending).toEqual({ approved: false, comment: '边界没覆盖' });
  });

  it('未知待审节点 review 抛可读错误', () => {
    const q = new CheckReviewQueue();
    expect(() => q.review('TASK-X', 'T-9', true)).toThrow('待审节点不存在或已复核');
  });

  it('同节点重复申报：旧挂起以驳回兜底唤醒，防泄漏', async () => {
    const q = new CheckReviewQueue();
    const gate = gateForTask(q, 'TASK-A');
    const first = gate.review({ item: 'T-1', result: 'v1', passed: true });
    const second = gate.review({ item: 'T-1', result: 'v2', passed: true });
    expect(await first).toMatchObject({ approved: false });
    q.review('TASK-A', 'T-1', true);
    expect(await second).toEqual({ approved: true });
  });

  it('review 带 operator（2026-09-11 API token 操作者名）：verdict 透传供 intervention 留痕', async () => {
    const q = new CheckReviewQueue();
    const gate = gateForTask(q, 'TASK-A');
    const pending = gate.review({ item: 'T-1', result: '构建通过', passed: true });
    q.review('TASK-A', 'T-1', true, 'LGTM', '张三');
    expect(await pending).toEqual({ approved: true, comment: 'LGTM', operator: '张三' });
    // 不带 operator 的旧调用零回归（鉴权未启用）
    const pending2 = gate.review({ item: 'T-2', result: 'x', passed: true });
    q.review('TASK-A', 'T-2', false);
    expect(await pending2).toEqual({ approved: false });
  });
});

describe('listPendingChecks（事件流推导待审，重启安全）', () => {
  let dir: string;
  const ev = (over: Partial<AgentEvent> & { id: string }): AgentEvent => ({
    ts: 1, taskId: 'TASK-A', employeeId: 'emp-01', type: 'task_check', summary: over.id, ...over,
  });

  it('task_check(awaiting) 进待审；后续 intervention(approved) 清除', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-review-'));
    try {
      const events = new FileEventStore(dir);
      const t0 = Date.now();
      await events.append(ev({ id: 'a1', ts: t0, payload: { item: 'T-1', result: '构建通过', awaiting: true } }));
      await events.append(ev({ id: 'a2', ts: t0 + 1, type: 'task_check', payload: { item: 'T-2', result: '自测通过', awaiting: true } }));

      let pending = await listPendingChecks(events);
      expect(pending).toEqual([
        { taskId: 'TASK-A', item: 'T-1', result: '构建通过' },
        { taskId: 'TASK-A', item: 'T-2', result: '自测通过' },
      ]);

      // 人工放行 T-1（runtime checkpoint 发出的 intervention 复核留痕）
      await events.append(ev({ id: 'a3', ts: t0 + 2, type: 'intervention', summary: '人工放行节点 T-1', payload: { item: 'T-1', approved: true } }));
      pending = await listPendingChecks(events);
      expect(pending).toEqual([{ taskId: 'TASK-A', item: 'T-2', result: '自测通过' }]);

      // 人工驳回 T-2 同样清除（进入修正-重报循环）
      await events.append(ev({ id: 'a4', ts: t0 + 3, type: 'intervention', summary: '人工驳回节点 T-2', payload: { item: 'T-2', approved: false, comment: 'x' } }));
      expect(await listPendingChecks(events)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('无 gate 的 task_check（无 awaiting）不进待审列表（P9 零回归）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-review2-'));
    try {
      const events = new FileEventStore(dir);
      await events.append(ev({ id: 'b1', payload: { item: 'T-1', result: '构建通过', passed: true } }));
      expect(await listPendingChecks(events)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
