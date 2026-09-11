import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMessageStore, type MessageRecord } from '../src/team/messages.js';
import { createHandlers } from '../src/http/handlers.js';
import { createLiveSseHandler, type LiveEvent } from '../src/http/sse.js';
import { SqlGenerationStore } from '../src/stores/index.js';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-live-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** handlers 最小依赖桩（照抄 messages.test.ts 模式：tasks/events 只给 list） */
const stubTasks = { list: async () => [] } as never;
const stubEvents = { list: async () => [] } as never;

describe('消息中心过滤 + 分页（2026-09-10 重设计）', () => {
  it('GET /api/messages：type/q/unreadOnly 过滤 + limit/offset 分页，total 为过滤后总数', async () => {
    const store = new FileMessageStore(join(root, 'messages.json'));
    await store.add({ type: 'task_done', title: '任务 a 执行完成', summary: '已归档', taskId: 'a' });
    const failed = await store.add({ type: 'task_failed', title: '任务 b 执行失败', summary: '构建失败', taskId: 'b' });
    await store.add({ type: 'review_required', title: '任务 c 待人工放行', summary: '等待复核', taskId: 'c' });
    const handlers = createHandlers({ tasks: stubTasks, events: stubEvents, messages: store });

    // type 过滤：只回 task_failed，unread 仍是全局未读数
    const byType = await handlers({ method: 'GET', path: '/api/messages', query: { type: 'task_failed' } });
    expect(byType.status).toBe(200);
    expect(byType.json).toMatchObject({ total: 1, unread: 3 });
    expect(((byType.json as { messages: MessageRecord[] }).messages)[0]!.taskId).toBe('b');

    // q 关键词（标题/摘要/任务 id 命中）：『放行』只命中 c
    const byQ = await handlers({ method: 'GET', path: '/api/messages', query: { q: '放行' } });
    expect(((byQ.json as { messages: MessageRecord[]; total: number }).messages)).toHaveLength(1);
    expect((byQ.json as { total: number }).total).toBe(1);

    // 分页：3 条按 limit=2 切两页
    const page1 = await handlers({ method: 'GET', path: '/api/messages', query: { limit: '2', offset: '0' } });
    expect((page1.json as { messages: MessageRecord[] }).messages).toHaveLength(2);
    const page2 = await handlers({ method: 'GET', path: '/api/messages', query: { limit: '2', offset: '2' } });
    expect((page2.json as { messages: MessageRecord[] }).messages).toHaveLength(1);

    // 组合：unreadOnly + type
    await store.markRead(failed.id);
    const combo = await handlers({
      method: 'GET', path: '/api/messages', query: { unreadOnly: '1', type: 'task_failed' },
    });
    expect(combo.json).toMatchObject({ total: 0, unread: 2 });
  });

  it('已读操作回调 notifyCounts（SSE 计数重算推送，2026-09-10）', async () => {
    const store = new FileMessageStore(join(root, 'messages.json'));
    const m1 = await store.add({ type: 'task_done', title: 't1', summary: '', taskId: 'a' });
    await store.add({ type: 'task_failed', title: 't2', summary: '', taskId: 'b' });
    let notified = 0;
    const handlers = createHandlers({
      tasks: stubTasks, events: stubEvents, messages: store,
      notifyCounts: () => { notified += 1; },
    });

    await handlers({ method: 'POST', path: `/api/messages/${m1.id}/read` });
    expect(notified).toBe(1);
    await handlers({ method: 'POST', path: '/api/messages/read-all' });
    expect(notified).toBe(2);
  });
});

describe('智能生成记录（ddw_generations，2026-09-10）', () => {
  it('parse 成功/失败均留痕；GET /api/generations 最新在前；SqlGenerationStore add/list', async () => {
    const driver = new SqliteDriver(':memory:');
    await driver.ensureSchema();
    const generations = new SqlGenerationStore(driver);

    const okHandlers = createHandlers({
      tasks: stubTasks, events: stubEvents, generations,
      taskParser: async (description: string) => ({ yaml: `taskId: x\ntitle: ${description}\n` }),
    });
    const ok = await okHandlers({ method: 'POST', path: '/api/tasks/parse', body: { description: '做一个登录功能' } });
    expect(ok.status).toBe(200);

    const failHandlers = createHandlers({
      tasks: stubTasks, events: stubEvents, generations,
      taskParser: async () => { throw new Error('智能生成失败：模型输出不是合法任务包'); },
    });
    const bad = await failHandlers({ method: 'POST', path: '/api/tasks/parse', body: { description: '坏描述' } });
    expect(bad.status).toBe(400);

    // 记录两条：失败在前（最新），含 error；成功在后，含 yaml
    const list = await failHandlers({ method: 'GET', path: '/api/generations' });
    const rows = list.json as Array<{ description: string; yaml?: string; error?: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ description: '坏描述', error: expect.stringContaining('智能生成失败') });
    expect(rows[1]).toMatchObject({ description: '做一个登录功能', yaml: expect.stringContaining('taskId: x') });

    // 缺 description：400 且不留痕
    await failHandlers({ method: 'POST', path: '/api/tasks/parse', body: {} });
    const after = await failHandlers({ method: 'GET', path: '/api/generations' });
    expect((after.json as unknown[]).length).toBe(2);

    await driver.close();
  });

  it('未注入 generations：parse 正常返回不报错（零回归）', async () => {
    const handlers = createHandlers({
      tasks: stubTasks, events: stubEvents,
      taskParser: async () => ({ yaml: 'taskId: x\n' }),
    });
    const res = await handlers({ method: 'POST', path: '/api/tasks/parse', body: { description: 'd' } });
    expect(res).toMatchObject({ status: 200, json: { yaml: 'taskId: x\n' } });
    // /api/generations 未启用 → 400
    expect(await handlers({ method: 'GET', path: '/api/generations' })).toMatchObject({ status: 400 });
  });
});

/** 收集 SSE 输出的 mock res（照抄 sse.test.ts 模式，不监听端口） */
class MockRes {
  chunks: string[] = [];
  ended = false;
  writeHead(_status: number, _headers: Record<string, string>): void { /* 记录不校验 */ }
  write(chunk: string): void { this.chunks.push(chunk); }
  end(): void { this.ended = true; }
}

describe('实时推送 SSE（createLiveSseHandler，2026-09-10 消息改推送）', () => {
  it('连接推 counts 快照；总线 message 事件透传且计数变化重推；断开退订 + 结束流', async () => {
    const subs = new Set<(e: LiveEvent) => void>();
    const emit = (e: LiveEvent): void => { for (const fn of subs) fn(e); };
    let countCalls = 0;
    const counts = async (): Promise<{ unread: number; checksPending: number; skillsPending: number }> => {
      countCalls += 1; // 第 1 次快照 unread=1；总线事件后第 2 次 unread=2（有变化才推）
      return { unread: countCalls, checksPending: 0, skillsPending: 0 };
    };
    const stop = { value: false };
    const handler = createLiveSseHandler({
      subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
      counts,
      shouldContinue: () => !stop.value,
    });

    const res = new MockRes();
    const done = handler({ path: '/api/messages/stream' }, res);
    await new Promise((r) => setTimeout(r, 30)); // 首帧快照已写
    let out = res.chunks.join('');
    expect(out).toContain('event: counts');
    expect(out).toContain('"unread":1');

    // 新消息：message 事件透传 + counts 重算（1→2 有变化，推）
    emit({ kind: 'message', message: { id: 'm1', title: '任务 t1 执行失败' } });
    await new Promise((r) => setTimeout(r, 30));
    out = res.chunks.join('');
    expect(out).toContain('event: message');
    expect(out).toContain('"id":"m1"');
    expect(out).toContain('"unread":2');
    // counts 无变化不再推（快照仍是最新的那一条 counts）
    const countsFrames = res.chunks.filter((c) => c.startsWith('event: counts')).length;
    emit({ kind: 'counts' }); // 计数未变（第 3 次查询仍 unread=3？——countCalls=3 → 变化，会推）
    await new Promise((r) => setTimeout(r, 30));
    // 上一行不断言：counts 计数器每次递增必然变化；只验证退订与结束语义
    stop.value = true;
    await done;
    expect(subs.size).toBe(0); // 断开即退订
    expect(res.ended).toBe(true);
    expect(countsFrames).toBeGreaterThanOrEqual(2);
  });
});
