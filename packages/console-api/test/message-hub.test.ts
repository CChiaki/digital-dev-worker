import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTaskStore, FileEventStore } from '../src/stores/index.js';
import { wrapEventStoreForMessages, wrapTaskStoreForMessages, type MessageSink } from '../src/team/message-hub.js';
import type { MessageRecord } from '../src/team/messages.js';
import type { AgentEvent, TaskPackage } from '@ddw/runtime';
import { parseTaskPackage } from '@ddw/runtime';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-msg-hub-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sinkOf = (seen: MessageRecord[]): MessageSink => ({
  onMessage: async (m) => {
    seen.push(m as MessageRecord);
  },
});

async function samplePkg(taskId: string): Promise<TaskPackage> {
  const yaml = await readFile(
    new URL('../../../examples/task-package.example.yaml', import.meta.url),
    'utf8',
  );
  return { ...parseTaskPackage(yaml), taskId };
}

const ev = (over: Partial<AgentEvent>): AgentEvent => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  ts: 1000,
  taskId: 'TASK-1',
  employeeId: 'emp-01',
  type: 'tool_call',
  summary: 'bash',
  ...over,
});

describe('消息生成装饰器（2026-09-06）', () => {
  it('wrapTaskStoreForMessages：finish ok=true → task_done；ok=false → task_failed（title 含 taskId）', async () => {
    const seen: MessageRecord[] = [];
    const store = wrapTaskStoreForMessages(new FileTaskStore(root), sinkOf(seen));
    const pkg = await samplePkg('TASK-1');
    await store.add(pkg);
    await store.claim(pkg.taskId, 'emp-01');
    await store.markRunning(pkg.taskId);
    await store.finish(pkg.taskId, { status: 'done', reply: '执行失败原因', turns: 1 }, false);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'task_failed', taskId: pkg.taskId, summary: '执行失败原因' });
    expect(seen[0]!.title).toContain(pkg.taskId);
    expect(seen[0]!.id).toBeUndefined();
    expect(seen[0]!.createdAt).toBeUndefined();

    // ok=true → task_done
    const store2 = wrapTaskStoreForMessages(new FileTaskStore(root), sinkOf(seen));
    await store2.add(await samplePkg('TASK-2'));
    await store2.finish('TASK-2', { status: 'done', reply: '搞定', turns: 3 }, true);
    expect(seen[1]).toMatchObject({ type: 'task_done', taskId: 'TASK-2', summary: '搞定' });
    expect(seen[1]!.title).toContain('TASK-2');
  });

  it('wrapEventStoreForMessages：task_check 事件 awaiting=true → review_required；其余事件不产生消息', async () => {
    const seen: MessageRecord[] = [];
    const wrapped = wrapEventStoreForMessages(new FileEventStore(root), sinkOf(seen));
    await wrapped.append({
      ...ev({ id: 'e1', ts: 1, type: 'task_check', summary: '申报' }),
      payload: { awaiting: true, item: 't1', passed: true, result: 'done' },
    });
    await wrapped.append(ev({ id: 'e2', ts: 2, type: 'tool_call', summary: 'bash' }));
    // awaiting 缺省/为 false 的 task_check 不产生消息
    await wrapped.append({ ...ev({ id: 'e3', ts: 3, type: 'task_check', summary: '申报' }), payload: { awaiting: false } });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'review_required', taskId: 'TASK-1', employeeId: 'emp-01', summary: '申报' });
    expect(seen[0]!.title).toContain('TASK-1');
  });

  it('onEvent 钩子（2026-09-10 角标消退还慢）：每个事件落库后回调，裁决事件即时重算角标用', async () => {
    const seen: MessageRecord[] = [];
    const seenEvents: string[] = [];
    const wrapped = wrapEventStoreForMessages(new FileEventStore(root), sinkOf(seen), (e) => {
      seenEvents.push(`${e.type}:${e.id}`);
    });
    await wrapped.append(ev({ id: 'e1', ts: 1, type: 'intervention', summary: '人工放行节点 T-1' }));
    await wrapped.append(ev({ id: 'e2', ts: 2 }));
    // 落库即回调（含不产生消息的事件类型——server 据此在裁决落库时重算 counts）
    expect(seenEvents).toEqual(['intervention:e1', 'tool_call:e2']);
    expect(seen).toHaveLength(0); // 钩子不改变消息生成语义
  });

  it('装饰器透传：list/append/get 等其余方法委托 base（事件仍正常可查、任务状态机不变）', async () => {
    const seen: MessageRecord[] = [];
    const baseEvents = new FileEventStore(root);
    const wrappedEvents = wrapEventStoreForMessages(baseEvents, sinkOf(seen));
    await wrappedEvents.append(ev({ id: 'e1', ts: 1 }));
    // list 委托 base：数据可查（含 filter）
    expect((await wrappedEvents.list()).map((e) => e.id)).toEqual(['e1']);
    expect((await wrappedEvents.list({ taskId: 'NOPE' }))).toEqual([]);
    // 可选方法（file 实现的 hash 链）同样透传可用
    expect(typeof (await wrappedEvents.snapshotHead!())?.hash).toBe('string');
    expect((await wrappedEvents.verifyIntegrity!()).ok).toBe(true);

    const baseTasks = new FileTaskStore(root);
    const wrappedTasks = wrapTaskStoreForMessages(baseTasks, sinkOf(seen));
    const pkg = await samplePkg('TASK-1');
    await wrappedTasks.add(pkg, { draft: true }); // opts 透传（Task 1/4 发布态）
    expect((await wrappedTasks.get('TASK-1'))?.status).toBe('draft');
    await wrappedTasks.publish('TASK-1');
    expect((await wrappedTasks.get('TASK-1'))?.status).toBe('pending');
    await wrappedTasks.claim('TASK-1', 'emp-01');
    await wrappedTasks.markRunning('TASK-1');
    await wrappedTasks.finish('TASK-1', { status: 'done', reply: 'r', turns: 1 }, false, [{ itemId: 'i1', kind: 'dev', title: 't', status: 'done' }], 'i1');
    const rec = await wrappedTasks.get('TASK-1');
    expect(rec?.status).toBe('failed');
    expect(rec?.failedItemId).toBe('i1');
    await wrappedTasks.resumePlan('TASK-1');
    expect((await wrappedTasks.get('TASK-1'))?.status).toBe('pending');
    expect((await wrappedTasks.list()).map((r) => r.pkg.taskId)).toEqual(['TASK-1']);
    // 非 finish 路径不产生消息（add/claim/markRunning/publish/resumePlan 零消息）
    expect(seen).toHaveLength(1);
  });
});
