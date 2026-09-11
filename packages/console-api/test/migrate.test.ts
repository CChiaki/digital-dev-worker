import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigration } from '../src/migrate.js';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import { SqlEventStore } from '../src/stores/sql/sql-event-store.js';
import { GENESIS_HASH, canonicalContent, computeHash } from '../src/stores/hash-chain.js';

/**
 * 一次性迁移命令（存储企业化 Task 8）：临时目录造旧 sqlite（task/event 旧表直插）+ 5 个 JSON 档案
 * → migrate 到 :memory: sqlite 目标 → 断言各域条数与内容往返一致（含 doc JSON 字段）；
 * 目标非空拒绝 / marker 落盘 / 缺源文件跳过汇总 / 同文件目标拒绝。
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ddw-migrate-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 旧 sqlite 存量 schema（SqliteTaskStore/SqliteEventStore 退役前落库形态，029f9a6） */
const LEGACY_DDL = `
  CREATE TABLE IF NOT EXISTS task (
    id TEXT PRIMARY KEY,
    pkg TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    claimed_by TEXT,
    claimed_at INTEGER,
    result TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS event (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    ts INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload TEXT,
    prev_hash TEXT,
    hash TEXT
  );
`;

interface LegacyEventInput {
  id: string; ts: number; taskId: string; employeeId: string; type: string; summary: string; payload?: unknown;
}

/** 按 T3 hash 链算法造成链完整的旧 event 行（迁移后 verifyIntegrity 应原样通过） */
function legacyEventRows(inputs: LegacyEventInput[]): { sql: string; params: unknown[] }[] {
  const rows: { sql: string; params: unknown[] }[] = [];
  let prev = GENESIS_HASH;
  for (const e of inputs) {
    const hash = computeHash(canonicalContent(e as never, 1), prev);
    rows.push({
      sql: 'INSERT INTO event (id, ts, task_id, employee_id, type, summary, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [e.id, e.ts, e.taskId, e.employeeId, e.type, e.summary, e.payload ? JSON.stringify(e.payload) : null, prev, hash],
    });
    prev = hash;
  }
  return rows;
}

const PKG_A = {
  taskId: 'T-1001', title: '登录页开发',
  repo: { url: 'http://gitlab.inner/x.git', branch: 'main' },
  tasks: [{ id: 'T-1001-1', title: '表单', files: ['src/login.vue'], requirement: 'r', acceptance: ['a'] }],
};

async function seedLegacyDir(d: string): Promise<void> {
  const db = new DatabaseSync(join(d, 'ddw.sqlite'));
  db.exec(LEGACY_DDL);
  db.prepare('INSERT INTO task (id, pkg, status, claimed_by, claimed_at, result, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('T-1001', JSON.stringify(PKG_A), 'finished', 'emp-a', 111, JSON.stringify({ ok: true, summary: '完成' }), 222);
  db.prepare('INSERT INTO task (id, pkg, status, updated_at) VALUES (?, ?, ?, ?)')
    .run('T-1002', JSON.stringify({ ...PKG_A, taskId: 'T-1002' }), 'pending', 333);
  for (const r of legacyEventRows([
    { id: 'e-1', ts: 1, taskId: 'T-1001', employeeId: 'emp-a', type: 'task_created', summary: '创建' },
    { id: 'e-2', ts: 2, taskId: 'T-1001', employeeId: 'emp-a', type: 'report', summary: '开工', payload: { step: 1 } },
    { id: 'e-3', ts: 3, taskId: 'T-1001', employeeId: 'emp-a', type: 'task_done', summary: '完成' },
  ])) {
    db.prepare(r.sql).run(...(r.params as never[]));
  }
  db.close();

  await writeFile(join(d, 'employees.json'), JSON.stringify([
    { id: 'emp-a', name: '小数', roles: ['后端开发', '测试'], capabilities: [], enabled: true, createdAt: 1 },
    { id: 'emp-b', name: '小智', roles: ['前端开发'], capabilities: ['dev'], enabled: false, createdAt: 2 },
  ]), 'utf8');
  await writeFile(join(d, 'skills.json'), JSON.stringify({
    categories: [{ id: 'backend', name: '后端开发' }, { id: 'frontend', name: '前端开发' }],
    skills: [{ id: 'skill-1', categoryId: 'backend', name: 'SQL 规范', description: 'd', type: 'knowledge', content: '# c', status: 'approved', source: 'manual', createdAt: 5 }],
  }), 'utf8');
  await writeFile(join(d, 'capabilities.json'), JSON.stringify([
    { kind: 'dev', name: '开发编码', description: '写代码', tools: { builtin: ['bash', 'files'], mcp: [] }, enabled: true },
  ]), 'utf8');
  await writeFile(join(d, 'messages.json'), JSON.stringify([
    { id: 'm-1', type: 'task_done', taskId: 'T-1001', summary: '完成', title: 't1', createdAt: 10 },
    { id: 'm-2', type: 'task_done', taskId: 'T-1001', summary: '完成2', title: 't2', createdAt: 11, readAt: 12 },
  ]), 'utf8');
  await writeFile(join(d, 'notification-channels.json'), JSON.stringify([
    { id: 'ch-1', type: 'webhook', name: '值班群', webhookUrl: 'http://hook/x', enabled: true },
  ]), 'utf8');
}

describe('migrate 一次性迁移（Task 8）', () => {
  it('旧 sqlite + 5 JSON → :memory: sqlite 目标：各域条数与内容往返一致', async () => {
    await seedLegacyDir(dir);
    const target = new SqliteDriver(':memory:');

    const summary = await runMigration({ dataDir: dir, to: 'sqlite', targetDriver: target });
    expect(summary.target).toBe('sqlite');
    expect(summary.skipped).toEqual([]);
    expect(summary).toMatchObject({ tasks: 2, events: 3, employees: 2, skillCategories: 2, skills: 1, capabilities: 1, messages: 2, channels: 1 });

    // 任务：窄列 + pkg/result JSON 往返一致
    const tasks = await target.all<Record<string, unknown>>('SELECT * FROM ddw_tasks ORDER BY id');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.id).toBe('T-1001');
    expect(tasks[0]!.status).toBe('finished');
    expect(tasks[0]!.claimed_by).toBe('emp-a');
    expect(JSON.parse(tasks[0]!.pkg as string)).toEqual(PKG_A);
    expect(JSON.parse(tasks[0]!.result as string)).toEqual({ ok: true, summary: '完成' });
    expect(tasks[0]!.updated_at).toBe(222);
    expect(tasks[1]!.claimed_by).toBeNull();

    // 事件：seq 原值保留 + payload 往返；审计 hash 链迁移后原样可校验
    const events = await target.all<Record<string, unknown>>('SELECT * FROM ddw_events ORDER BY seq');
    expect(events.map((e) => e.id)).toEqual(['e-1', 'e-2', 'e-3']);
    expect(events[1]!.payload).toBe(JSON.stringify({ step: 1 }));
    expect(events[2]!.prev_hash).toBe(events[1]!.hash);
    const integrity = await new SqlEventStore(target, { headsPath: null }).verifyIntegrity();
    expect(integrity.ok).toBe(true);
    expect(integrity.total).toBe(3);

    // 员工：doc 原样（roles 数组不 normalize）+ enabled 窄列
    const emps = await target.all<Record<string, unknown>>('SELECT * FROM ddw_employees ORDER BY id');
    expect(emps.map((e) => e.id)).toEqual(['emp-a', 'emp-b']);
    expect(emps[0]!.enabled).toBe(1);
    expect(emps[1]!.enabled).toBe(0);
    expect(JSON.parse(emps[0]!.doc as string)).toMatchObject({ id: 'emp-a', roles: ['后端开发', '测试'] });

    // Skill：分类 + 条目（doc 原样，status 窄列）
    const cats = await target.all<Record<string, unknown>>('SELECT * FROM ddw_skill_categories ORDER BY id');
    expect(cats.map((c) => c.id)).toEqual(['backend', 'frontend']);
    expect(JSON.parse(cats[0]!.doc as string)).toEqual({ id: 'backend', name: '后端开发' });
    const skillRows = await target.all<Record<string, unknown>>('SELECT * FROM ddw_skills');
    expect(skillRows).toHaveLength(1);
    expect(skillRows[0]!.status).toBe('approved');
    expect(JSON.parse(skillRows[0]!.doc as string)).toMatchObject({ id: 'skill-1', categoryId: 'backend' });

    // 能力 / 消息（read 窄列 = readAt）/ 渠道
    const caps = await target.all<Record<string, unknown>>('SELECT * FROM ddw_capabilities');
    expect(caps.map((c) => c.kind)).toEqual(['dev']);
    const msgs = await target.all<Record<string, unknown>>('SELECT * FROM ddw_messages ORDER BY created_at');
    expect(msgs.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    expect(msgs[0]!.read).toBe(0);
    expect(msgs[1]!.read).toBe(1);
    expect(JSON.parse(msgs[1]!.doc as string).readAt).toBe(12);
    const chans = await target.all<Record<string, unknown>>('SELECT * FROM ddw_channels');
    expect(chans.map((c) => c.id)).toEqual(['ch-1']);

    await target.close();
  });

  it('目标库非空：拒绝迁移（中文报错）', async () => {
    await seedLegacyDir(dir);
    const target = new SqliteDriver(':memory:');
    await target.ensureSchema();
    await target.run("INSERT INTO ddw_employees (id, enabled, doc, updated_at) VALUES ('x', 1, ?, 1)", ['{}']);

    await expect(runMigration({ dataDir: dir, targetDriver: target })).rejects.toThrow('目标库非空，拒绝迁移');
    // 拒绝后目标库内容不被破坏
    const n = await target.all<{ n: unknown }>('SELECT COUNT(*) AS n FROM ddw_tasks');
    expect(Number(n[0]!.n)).toBe(0);
    await target.close();
  });

  it('成功写 migrated-sqlite.marker（时间戳 + 各域条数），旧文件原样未动', async () => {
    await seedLegacyDir(dir);
    const before = readFile(join(dir, 'ddw.sqlite'));
    const target = new SqliteDriver(':memory:');
    const summary = await runMigration({ dataDir: dir, targetDriver: target });
    await target.close();

    const markerPath = join(dir, 'migrated-sqlite.marker');
    expect(summary.markerPath).toBe(markerPath);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    expect(typeof marker.migratedAt).toBe('string');
    expect(marker).toMatchObject({ target: 'sqlite', tasks: 2, events: 3, employees: 2, channels: 1 });

    // 源文件未动（字节数不变）
    expect(await readFile(join(dir, 'ddw.sqlite'))).toEqual(await before);
  });

  it('缺源文件：逐项跳过并在汇总注明，迁移照常完成（0 条）', async () => {
    // 只给 employees.json，其余全缺
    await writeFile(join(dir, 'employees.json'), JSON.stringify([
      { id: 'emp-a', name: '小数', roles: ['后端开发'], capabilities: [], enabled: true, createdAt: 1 },
    ]), 'utf8');
    const target = new SqliteDriver(':memory:');
    const summary = await runMigration({ dataDir: dir, targetDriver: target });
    await target.close();

    expect(summary.employees).toBe(1);
    expect(summary.tasks).toBe(0);
    expect(summary.events).toBe(0);
    expect(summary.skipped).toEqual([
      '旧 sqlite ddw.sqlite（task/event 表）',
      'skills.json（Skill 库）',
      'capabilities.json（能力注册表）',
      'messages.json（消息中心）',
      'notification-channels.json（通知渠道）',
    ]);
  });

  it('更旧存量库：task 无 plan_progress/failed_item_id、event 无 hash_version 列——按列交集迁移不炸', async () => {
    const db = new DatabaseSync(join(dir, 'ddw.sqlite'));
    db.exec(LEGACY_DDL);
    db.prepare('INSERT INTO task (id, pkg, status, updated_at) VALUES (?, ?, ?, ?)')
      .run('T-OLD', JSON.stringify({ taskId: 'T-OLD' }), 'pending', 9);
    db.prepare('INSERT INTO event (id, ts, task_id, employee_id, type, summary) VALUES (?, ?, ?, ?, ?, ?)')
      .run('e-old', 1, 'T-OLD', 'emp', 'task_created', '创建');
    db.close();
    const target = new SqliteDriver(':memory:');
    const summary = await runMigration({ dataDir: dir, targetDriver: target });

    expect(summary).toMatchObject({ tasks: 1, events: 1 });
    const ev = await target.all<Record<string, unknown>>('SELECT * FROM ddw_events');
    expect(ev[0]!.hash_version).toBe(1);
    expect(ev[0]!.prev_hash).toBeNull();
    const tk = await target.all<Record<string, unknown>>('SELECT * FROM ddw_tasks');
    expect(tk[0]!.plan_progress).toBeNull();
    await target.close();
  });

  it('sqlite 目标与源同文件：拒绝迁移（防自覆盖）', async () => {
    await expect(runMigration({ dataDir: dir, to: 'sqlite' })).rejects.toThrow('拒绝迁移');
  });

  it('runtime 显式指向源文件（含符号链接）：realpath 比对后拒绝迁移（T8 评审 P3）', async () => {
    await seedLegacyDir(dir);
    // 直接指向源文件的显式路径（修前只比对缺省路径，此路径绕过防护）
    await writeFile(join(dir, 'runtime-same.yaml'), [
      'storage:',
      `  driver: sqlite`,
      `  path: ${join(dir, 'ddw.sqlite')}`,
    ].join('\n'), 'utf8');
    await expect(runMigration({ dataDir: dir, runtimePath: join(dir, 'runtime-same.yaml') })).rejects.toThrow('拒绝迁移');

    // 指向同一文件的符号链接（realpath 解析后同源文件，也须拦住）
    const link = join(dir, 'link-ddw.sqlite');
    symlinkSync(join(dir, 'ddw.sqlite'), link);
    await writeFile(join(dir, 'runtime-link.yaml'), [
      'storage:',
      `  driver: sqlite`,
      `  path: ${link}`,
    ].join('\n'), 'utf8');
    await expect(runMigration({ dataDir: dir, runtimePath: join(dir, 'runtime-link.yaml') })).rejects.toThrow('拒绝迁移');

    // 真·不同文件照常放行
    await writeFile(join(dir, 'runtime-other.yaml'), [
      'storage:',
      `  driver: sqlite`,
      `  path: ${join(dir, 'other.sqlite')}`,
    ].join('\n'), 'utf8');
    const target = new SqliteDriver(':memory:');
    const summary = await runMigration({ dataDir: dir, runtimePath: join(dir, 'runtime-other.yaml'), targetDriver: target });
    expect(summary.tasks).toBe(2);
    await target.close();
  });

  it('残行不静默丢：无 id 的源行计数进 skipped/skippedRows，可对账（T8 评审 P3）', async () => {
    await seedLegacyDir(dir);
    // employees.json 混入一条无 id 的残行（修前静默 continue，汇总对不上账）
    await writeFile(join(dir, 'employees.json'), JSON.stringify([
      { id: 'emp-a', name: '小数', roles: ['后端开发'], capabilities: [], enabled: true, createdAt: 1 },
      { name: '无 id 残行' },
      { id: 'emp-b', name: '小智', roles: ['前端开发'], capabilities: [], enabled: true, createdAt: 2 },
    ]), 'utf8');
    const target = new SqliteDriver(':memory:');
    const summary = await runMigration({ dataDir: dir, to: 'sqlite', targetDriver: target });
    await target.close();

    expect(summary.employees).toBe(2);
    expect(summary.skippedRows).toBe(1);
    expect(summary.skipped).toContain('残行 1 条（employee 1 条）');
    // 对账：源 3 条 = 导入 2 + 残行 1
    expect(summary.employees + summary.skippedRows).toBe(3);
  });
});
