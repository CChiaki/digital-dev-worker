import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlPushLogStore } from '../src/stores/sql/sql-push-log-store.js';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import { createHandlers } from '../src/http/handlers.js';
import { FileTaskStore, FileEventStore } from '../src/stores/index.js';
import type { PushLogRecord } from '../src/team/push-log.js';

let dir: string;
let store: SqlPushLogStore;
let driver: SqliteDriver;

const rec = (over: Partial<Omit<PushLogRecord, 'id' | 'createdAt'>>): Omit<PushLogRecord, 'id' | 'createdAt'> => ({
  messageId: 'msg-1', taskId: 'TASK-1', messageTitle: '任务 TASK-1 待人工放行',
  channelId: 'y1', channelType: 'yanxun', channelName: '燕讯',
  status: 'sent',
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ddw-pushlog-'));
  driver = new SqliteDriver(join(dir, 'ddw.sqlite'));
  await driver.ensureSchema();
  store = new SqlPushLogStore(driver);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SqlPushLogStore（推送留痕，2026-09-10）', () => {
  it('add 补 id（push 前缀）/createdAt；list 最新在前 + taskId/messageId 过滤 + limit', async () => {
    const first = await store.add(rec({ messageId: 'msg-1' }));
    const second = await store.add(rec({ messageId: 'msg-2', taskId: 'TASK-2', status: 'failed', error: 'HTTP 500' }));
    expect(first.id).toMatch(/^push-/);
    expect(first.createdAt).toBeGreaterThan(0);

    // 最新在前
    const all = await store.list();
    expect(all.map((r) => r.messageId)).toEqual(['msg-2', 'msg-1']);
    // taskId 过滤
    expect((await store.list({ taskId: 'TASK-2' })).map((r) => r.messageId)).toEqual(['msg-2']);
    // messageId 过滤（消息中心下钻）
    expect((await store.list({ messageId: 'msg-1' }))).toHaveLength(1);
    // limit
    expect(await store.list({ limit: 1 })).toHaveLength(1);
    // failed 记录带 error 原样
    expect(all[0]).toMatchObject({ status: 'failed', error: 'HTTP 500' });
  });

  it('燕讯流水号留痕（yanxunSeqNo 原样存取；sent 记录无 error）', async () => {
    await store.add(rec({ yanxunSeqNo: 'R0251202609111530010123456789abcdef' }));
    const [r] = await store.list();
    expect(r?.yanxunSeqNo).toBe('R0251202609111530010123456789abcdef');
    expect(r?.error).toBeUndefined();
  });
});

describe('GET /api/push-logs（handlers，2026-09-10）', () => {
  it('未注入 → 400；注入后返回 list 结果（query 透传 taskId/limit）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-pushlog-h-'));
    try {
      const noDeps = createHandlers({ tasks: new FileTaskStore(root), events: new FileEventStore(root) });
      expect((await noDeps({ method: 'GET', path: '/api/push-logs' })).status).toBe(400);

      const sDriver = new SqliteDriver(join(root, 'ddw.sqlite'));
      await sDriver.ensureSchema();
      const s = new SqlPushLogStore(sDriver);
      await s.add(rec({ taskId: 'TASK-1' }));
      await s.add(rec({ messageId: 'msg-9', taskId: 'TASK-9' }));
      const handle = createHandlers({ tasks: new FileTaskStore(root), events: new FileEventStore(root), pushLogs: s });

      const res = await handle({ method: 'GET', path: '/api/push-logs', query: { taskId: 'TASK-9', limit: '10' } });
      expect(res.status).toBe(200);
      expect(res.json).toHaveLength(1);
      expect((res.json as PushLogRecord[])[0]).toMatchObject({ taskId: 'TASK-9' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
