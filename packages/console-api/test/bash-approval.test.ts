import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deepStrictEqual } from 'node:assert';
import type { AgentEvent } from '@ddw/runtime';
import { CheckReviewQueue, gateForTask, listPendingChecks } from '../src/team/review-gate.js';
import { makeBashApproval } from '../src/team/bash-approval.js';
import { FileEventStore } from '../src/stores/index.js';
import { wrapEventStoreForMessages } from '../src/team/message-hub.js';
import { FileMessageStore, type MessageRecord } from '../src/team/messages.js';

/**
 * run_cmd 白名单外命令人工放行（2026-09-10 用户需求）：
 * makeBashApproval 的契约 = 复用 task_check 闸门链路零前端改动——
 * ① gate.review 挂起（真实 CheckReviewQueue，POST /api/.../review 同一入口唤醒）
 * ② task_check(awaiting) 事件 → listPendingChecks 进人工放行菜单 + 消息中心 review_required
 * ③ 裁决后 intervention 留痕清除待审；同命令名记忆（放行过不再问）
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ddw-bashappr-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/**
 * 轮询等待待审列表等于期望（2026-09-10 全量跑偶发红根因：approval 的 task_check 事件
 * 要经 emit → JSONL 落盘才可见，固定 sleep 5ms 在整仓并发跑时不够，读到空列表）。
 */
async function waitPending(events: FileEventStore, expected: unknown[], ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const pending = (await listPendingChecks(events)).sort((a, b) => a.item.localeCompare(b.item));
    try {
      deepStrictEqual(pending, expected);
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

/** 轮询等消息回调抵达（2026-09-11 同 waitPending 的并发根因：onMessage 异步于事件落盘可见性——
 *  事件已可读但 fire-and-forget 回调还没推入 seen，整仓并发跑时微任务间隙被放大） */
async function waitSeen(seen: MessageRecord[], pred: (m: MessageRecord) => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!seen.some(pred)) {
    if (Date.now() > deadline) return; // 超时交回断言层报真实缺口
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 组装被测闭包 + 真实队列 + 事件（可选消息装饰验证推送链） */
async function setup() {
  const queue = new CheckReviewQueue();
  const events = new FileEventStore(dir);
  const messages = new FileMessageStore(join(dir, 'messages.json'));
  const seen: MessageRecord[] = [];
  const wrapped = wrapEventStoreForMessages(events, {
    onMessage: async (m) => { seen.push({ ...m, id: 'x', createdAt: 0 } as MessageRecord); },
  });
  const emit = (e: Pick<AgentEvent, 'type' | 'summary' | 'payload'>): Promise<void> =>
    wrapped.append({ id: randomUUID(), ts: Date.now(), taskId: 'TASK-B', employeeId: 'emo-01', ...e });
  const approval = makeBashApproval({ gate: gateForTask(queue, 'TASK-B'), emit });
  return { queue, events, messages, seen, approval, emit };
}

describe('makeBashApproval（白名单外命令人工放行）', () => {
  it('全链路：挂起等审 → 待审可见（含命令原文）→ review 放行 → intervention 留痕 → 记忆同命令名', async () => {
    const { queue, events, seen, approval } = await setup();

    const first = approval('docker ps -a');
    // 待审推导：人工放行菜单看到 bash-1 + 命令原文（审批人知道自己在放行什么）
    await waitPending(events, [{ taskId: 'TASK-B', item: 'bash-1', result: 'docker ps -a' }]);
    // 消息中心：review_required 已推（title/summary 语义正确）
    await waitSeen(seen, (m) => m.type === 'review_required');
    expect(seen.filter((m) => m.type === 'review_required')).toHaveLength(1);
    expect(seen[0]!.summary).toContain('docker ps -a');

    queue.review('TASK-B', 'bash-1', true);
    expect(await first).toEqual({ approved: true });

    // intervention 留痕清除待审；审批人侧待审列表归零
    expect(await listPendingChecks(events)).toEqual([]);
    const resolved = (await events.list()).find((e) => e.type === 'intervention')!;
    expect(resolved.payload).toMatchObject({ item: 'bash-1', approved: true });

    // 记忆：同命令名（不同参数）不再挂起，直接放行且无新增待审
    const second = approval('docker images');
    expect(await second).toEqual({ approved: true });
    expect(await listPendingChecks(events)).toEqual([]);
    expect(seen.filter((m) => m.type === 'review_required')).toHaveLength(1); // 只推过一次消息
  });

  it('驳回：verdict（含意见）透传给 ControlledBash、不记忆，员工可换方案再触发', async () => {
    const { queue, approval } = await setup();

    const first = approval('tree /data');
    queue.review('TASK-B', 'bash-1', false, '目录太大，用 find 代替');
    expect(await first).toEqual({ approved: false, comment: '目录太大，用 find 代替' });

    // 驳回不记忆：同命令名再来仍要人工裁决
    const second = approval('tree /home');
    await new Promise((r) => setTimeout(r, 5));
    queue.review('TASK-B', 'bash-2', false);
    expect(await second).toEqual({ approved: false });
  });

  it('item 序号递增，多次待审互不覆盖', async () => {
    const { queue, events, approval } = await setup();
    const a = approval('mysql -e "select 1"');
    const b = approval('openssl version');

    await waitPending(events, [
      { taskId: 'TASK-B', item: 'bash-1', result: 'mysql -e "select 1"' },
      { taskId: 'TASK-B', item: 'bash-2', result: 'openssl version' },
    ]);
    queue.review('TASK-B', 'bash-1', true);
    queue.review('TASK-B', 'bash-2', true);
    expect(await a).toEqual({ approved: true });
    expect(await b).toEqual({ approved: true });
  });
});
