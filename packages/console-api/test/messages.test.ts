import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMessageStore, type MessageRecord } from '../src/team/messages.js';
import { createHandlers } from '../src/http/handlers.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-messages-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FileMessageStore（消息中心，2026-09-06）', () => {
  it('add/list/unreadCount/markRead/markAllRead；list unreadOnly 过滤；最新在前', async () => {
    const store = new FileMessageStore(join(root, 'messages.json'));
    const m1 = await store.add({ type: 'task_done', title: '任务 t1 执行完成', summary: 'r1', taskId: 't1' });
    await store.add({ type: 'task_failed', title: '任务 t2 执行失败', summary: 'r2', taskId: 't2' });
    await store.add({ type: 'review_required', title: '任务 t3 待人工放行', summary: 'r3', taskId: 't3', employeeId: 'emp-01' });

    // add 补齐 id/createdAt，readAt 缺省
    expect(m1.id).toBeTypeOf('string');
    expect(m1.createdAt).toBeTypeOf('number');
    expect(m1.readAt).toBeUndefined();

    expect(await store.unreadCount()).toBe(3);

    // markRead 一条：unread 2、readAt 落定、已读记录仍在
    expect(await store.markRead(m1.id)).toBe(true);
    expect(await store.unreadCount()).toBe(2);
    const readAtBefore = (await store.list()).find((m) => m.id === m1.id)!.readAt;
    expect(readAtBefore).toBeTypeOf('number');

    // 最新在前（add unshift）
    expect((await store.list()).map((m) => m.taskId)).toEqual(['t3', 't2', 't1']);
    // unreadOnly 只回未读（保持最新在前）
    expect((await store.list({ unreadOnly: true })).map((m) => m.taskId)).toEqual(['t3', 't2']);

    // markAllRead：只补未读的 readAt，返回标记条数
    expect(await store.markAllRead()).toBe(2);
    expect(await store.unreadCount()).toBe(0);
    expect(await store.list({ unreadOnly: true })).toEqual([]);
    expect(await store.list()).toHaveLength(3);
    // 先读的那条 readAt 不被 markAllRead 覆盖
    expect((await store.list()).find((m) => m.id === m1.id)!.readAt).toBe(readAtBefore);
  });

  it('1000 条上限：add 1001 条丢最旧，list 长度 1000 且首条是第 2 条', async () => {
    const store = new FileMessageStore(join(root, 'messages.json'));
    for (let i = 0; i < 1001; i++) {
      await store.add({ type: 'task_done', title: `t${i}`, summary: '', taskId: 'x' });
    }
    const all = await store.list();
    expect(all).toHaveLength(1000);
    expect(all[0]!.title).toBe('t1000');
    expect(all[999]!.title).toBe('t1');
    expect(all.find((m) => m.title === 't0')).toBeUndefined();
    expect(await store.unreadCount()).toBe(1000);
  });

  it('markRead 不存在的 id 返回 false；持久化（new 实例再 list 数据仍在）', async () => {
    const filePath = join(root, 'messages.json');
    const store = new FileMessageStore(filePath);
    const m = await store.add({ type: 'task_failed', title: '任务 t1 执行失败', summary: 'r', taskId: 't1' });
    await store.markRead(m.id);

    expect(await store.markRead('nope')).toBe(false);

    // 新实例（模拟重启）读回：记录与已读状态均持久化
    const store2 = new FileMessageStore(filePath);
    const list = await store2.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: 'task_failed', taskId: 't1', title: '任务 t1 执行失败' });
    expect(list[0]!.readAt).toBeTypeOf('number');
    expect(await store2.unreadCount()).toBe(0);
  });

  it('损坏文件不静默降级：list rejects（照抄 capabilities 存储模式）', async () => {
    const filePath = join(root, 'messages.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, '{"broken', 'utf8');
    const store = new FileMessageStore(filePath);
    await expect(store.list()).rejects.toThrow();
  });
});

describe('消息中心 API（handlers，2026-09-06）', () => {
  it('GET 列表+未读数 / POST 单条已读 / POST read-all；未注入 deps.messages 返回 400', async () => {
    const store = new FileMessageStore(join(root, 'messages.json'));
    const noStore = createHandlers({ tasks: { list: async () => [] } as never, events: { list: async () => [] } as never });
    expect(await noStore({ method: 'GET', path: '/api/messages' })).toMatchObject({ status: 400 });

    await store.add({ type: 'task_done', title: 't1', summary: '', taskId: 'a' });
    const second = await store.add({ type: 'task_failed', title: 't2', summary: '', taskId: 'b' });
    const handlers = createHandlers({
      tasks: { list: async () => [] } as never,
      events: { list: async () => [] } as never,
      messages: store,
    });

    // GET 全量 + unread
    const list = await handlers({ method: 'GET', path: '/api/messages' });
    expect(list.status).toBe(200);
    expect((list.json as { messages: MessageRecord[] }).messages).toHaveLength(2);
    expect((list.json as { unread: number }).unread).toBe(2);

    // GET unreadOnly=1 过滤在 markRead 后生效
    await handlers({ method: 'POST', path: `/api/messages/${second.id}/read` });
    const filtered = await handlers({ method: 'GET', path: '/api/messages', query: { unreadOnly: '1' } });
    expect((filtered.json as { messages: MessageRecord[] }).messages).toHaveLength(1);
    expect((filtered.json as { unread: number }).unread).toBe(1);

    // 单条已读 404
    expect(await handlers({ method: 'POST', path: '/api/messages/nope/read' })).toMatchObject({ status: 404 });

    // read-all
    const all = await handlers({ method: 'POST', path: '/api/messages/read-all' });
    expect(all.json).toMatchObject({ marked: 1 });
    expect(await store.unreadCount()).toBe(0);
  });
});
