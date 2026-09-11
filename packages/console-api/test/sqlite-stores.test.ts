import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqlTaskStore, SqlEventStore } from '../src/stores/index.js';
import type { TaskStore, EventStore } from '../src/stores/index.js';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import { createMysqlDriver } from '../src/stores/sql/mysql-driver.js';
import type { SqlDriver } from '../src/stores/sql/driver.js';
import { parseTaskPackage } from '@ddw/runtime';
import { mysqlTestUrl, resetMysqlTestDb } from './helpers/mysql.js';

/** 测试工厂：makeDriver(url?) —— sqlite 实现（:memory:/文件路径）或 mysql 实现（mysql:// url） */
async function makeDriver(url?: string): Promise<SqlDriver> {
  if (url?.startsWith('mysql://')) return createMysqlDriver(url);
  return new SqliteDriver(url ?? ':memory:');
}

/** makeTaskStore：建驱动 + ensureSchema + 包 SqlTaskStore（测试统一入口，换库只改这里） */
async function makeTaskStore(url?: string): Promise<{ store: TaskStore; driver: SqlDriver }> {
  const driver = await makeDriver(url);
  await driver.ensureSchema();
  return { store: new SqlTaskStore(driver), driver };
}

/** makeEventStore：同上事件流入口；url 传了文件路径时链头快照落 `<path>.heads.jsonl`（库外存证） */
async function makeEventStore(url = ':memory:'): Promise<{ store: EventStore; driver: SqlDriver }> {
  const driver = await makeDriver(url);
  await driver.ensureSchema();
  return { store: new SqlEventStore(driver, { headsPath: url === ':memory:' ? null : `${url}.heads.jsonl` }), driver };
}

// mysql 分支钩子（spec 存储企业化）：设 DDW_TEST_MYSQL_URL 才跑（Task 4 MysqlDriver 落地）
const mysqlUrl = process.env.DDW_TEST_MYSQL_URL;
const d = mysqlUrl ? describe : describe.skip;

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('SqlTaskStore 并发语义（sqlite 驱动）', () => {
  it('多员工并发抢单：UPDATE WHERE 原子性，有且仅有一个 claim 成功', async () => {
    const { store, driver } = await makeTaskStore();
    try {
      const pkg = parseTaskPackage(
        'taskId: TASK-CLAIM-RACE\ntitle: 抢单原子性\nrepo: { url: "http://gitlab.inner.bank/x.git", branch: main }\ntasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]',
      );
      await store.add(pkg);

      const results = await Promise.allSettled(
        ['emp-01', 'emp-02', 'emp-03'].map((id) => store.claim(pkg.taskId, id)),
      );
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(2);
      for (const r of lost) expect((r as PromiseRejectedResult).reason).toMatchObject({ message: expect.stringContaining('不可接单') });
      const rec = await store.get(pkg.taskId);
      expect(rec).toMatchObject({ status: 'claimed' });
      expect(['emp-01', 'emp-02', 'emp-03']).toContain(rec!.claimedBy);
    } finally {
      await driver.close();
    }
  });
});

describe('SqlTaskStore plan 进度与续跑（sqlite 驱动）', () => {
  it('finish 携带 planProgress/failedItemId 落库；resumePlan 仅 failed 可续（→pending，保留 progress，清停点）', async () => {
    const { store, driver } = await makeTaskStore();
    try {
      const pkg = parseTaskPackage(
        'taskId: TASK-PLAN-R\ntitle: 计划续跑\nrepo: { url: "http://gitlab.inner.bank/x.git", branch: main }\ntasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]',
      );
      await store.add(pkg);
      await store.claim(pkg.taskId, 'emp-01');
      await store.markRunning(pkg.taskId);
      const progress = [
        { itemId: 't1', kind: 'dev', title: '开发', status: 'done' as const },
        { itemId: 't2', kind: 'test', title: '测试', status: 'failed' as const },
        { itemId: 't3', kind: 'commit', title: '提交', status: 'skipped' as const },
      ];
      await store.finish(pkg.taskId, { status: 'done', reply: '测试未过', turns: 3 }, false, progress, 't2');
      let rec = await store.get(pkg.taskId);
      expect(rec?.planProgress).toEqual(progress);
      expect(rec?.failedItemId).toBe('t2');
      expect(rec?.status).toBe('failed');

      const resumed = await store.resumePlan(pkg.taskId);
      expect(resumed.status).toBe('pending');
      // 保留 done 项（续跑从停点续）；失败项复位 skipped——不残留「失败」标签（2026-09-06 用户反馈）
      expect(resumed.planProgress).toEqual([
        { itemId: 't1', kind: 'dev', title: '开发', status: 'done' },
        { itemId: 't2', kind: 'test', title: '测试', status: 'skipped' },
        { itemId: 't3', kind: 'commit', title: '提交', status: 'skipped' },
      ]);
      expect(resumed.failedItemId).toBeUndefined();
      // 谁失败谁继续（2026-09-06 用户语义）：原执行员工写为 assignee，调度器点名续接
      expect(resumed.pkg.assignee).toBe('emp-01');

      await expect(store.resumePlan(pkg.taskId)).rejects.toThrow(/仅 failed 任务可续跑/);
    } finally {
      await driver.close();
    }
  });

  it('finish 不带 progress/failedItemId 时保留既有值（fork crash 丢进度回归）；显式带值才覆盖', async () => {
    const { store, driver } = await makeTaskStore();
    try {
      const pkg = parseTaskPackage(
        'taskId: TASK-PLAN-K\ntitle: 进度保留\nrepo: { url: "http://gitlab.inner.bank/x.git", branch: main }\ntasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]',
      );
      await store.add(pkg);
      await store.claim(pkg.taskId, 'emp-01');
      await store.markRunning(pkg.taskId);
      const progress = [
        { itemId: 't1', kind: 'dev', title: '开发', status: 'done' as const },
        { itemId: 't2', kind: 'test', title: '测试', status: 'failed' as const },
      ];
      await store.finish(pkg.taskId, { status: 'done', reply: '停点', turns: 2 }, false, progress, 't2');

      // crash/异常收尾（fork crashOutcome 不带 progress）不得清空已有进度与停点
      await store.finish(pkg.taskId, { status: 'max_turns', reply: '执行进程异常退出', turns: 0 }, false);
      let rec = await store.get(pkg.taskId);
      expect(rec?.planProgress).toEqual(progress);
      expect(rec?.failedItemId).toBe('t2');
      expect(rec?.result?.reply).toBe('执行进程异常退出');

      // 显式带值才覆盖
      const progress2 = [{ itemId: 't2', kind: 'test', title: '测试', status: 'done' as const }];
      await store.finish(pkg.taskId, { status: 'done', reply: '续跑完成', turns: 1 }, true, progress2);
      rec = await store.get(pkg.taskId);
      expect(rec?.planProgress).toEqual(progress2);
      expect(rec?.status).toBe('done');
    } finally {
      await driver.close();
    }
  });

  it('存量旧库（task 表）打开不回归：ensureSchema 建 ddw_tasks，新存储可用（存量数据迁移另行执行）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-sql-task-mig-'));
    const dbPath = join(dir, 'ddw.sqlite');
    // 手工建退役前旧表（SqliteTaskStore 时代的 task 表）
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        pkg TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        claimed_by TEXT,
        claimed_at INTEGER,
        result TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
    old.close();

    const { store, driver } = await makeTaskStore(dbPath);
    try {
      const pkg = parseTaskPackage(
        'taskId: TASK-PLAN-MIG\ntitle: 旧库共存续跑\nrepo: { url: "http://gitlab.inner.bank/x.git", branch: main }\ntasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]',
      );
      await store.add(pkg);
      await store.claim(pkg.taskId, 'emp-01');
      await store.finish(pkg.taskId, { status: 'done', reply: '停点', turns: 1 }, false,
        [{ itemId: 't1', kind: 'dev', title: '开发', status: 'failed' }], 't1');
      expect((await store.get(pkg.taskId))?.failedItemId).toBe('t1');
      const resumed = await store.resumePlan(pkg.taskId);
      expect(resumed.status).toBe('pending');
    } finally {
      await driver.close();
    }
  });
});

// mysql 分支（Task 4）：同一套任务池/事件流语义真跑 mysql store（测试库强制改写 ddw_test，缺 env 整组 skip）
d('SqlTaskStore/SqlEventStore mysql 分支（DDW_TEST_MYSQL_URL）', () => {
  const MYSQL_DB = 'ddw_test_stores'; // 各测试文件独立库名：vitest 并行下互不踩踏
  let driver: SqlDriver;
  let headsDir: string;

  beforeAll(async () => {
    await resetMysqlTestDb(mysqlUrl!, MYSQL_DB); // DROP/CREATE 测试库（防误指生产库）
    driver = await makeDriver(mysqlTestUrl(mysqlUrl!, MYSQL_DB));
    await driver.ensureSchema();
    headsDir = await mkdtemp(join(tmpdir(), 'ddw-mysql-heads-'));
  });
  afterAll(async () => {
    await driver?.close(); // 库可留，表数据即弃
    if (headsDir) await rm(headsDir, { recursive: true, force: true });
  });

  const makeTasks = (): TaskStore => new SqlTaskStore(driver);
  const makeEvents = (): EventStore => new SqlEventStore(driver, { headsPath: join(headsDir, 'heads.jsonl') });

  afterEach(async () => {
    await driver.exec('DELETE FROM ddw_tasks');
    await driver.exec('DELETE FROM ddw_events');
  });

  it('多员工并发抢单：UPDATE WHERE 原子性，有且仅有一个 claim 成功', async () => {
    const store = makeTasks();
    const pkg = parseTaskPackage(
      'taskId: MYSQL-CLAIM-RACE\ntitle: 抢单原子性\nrepo: { url: "http://gitlab.inner.bank/x.git", branch: main }\ntasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]',
    );
    await store.add(pkg);

    const results = await Promise.allSettled(
      ['emp-01', 'emp-02', 'emp-03'].map((id) => store.claim(pkg.taskId, id)),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const r of lost) expect((r as PromiseRejectedResult).reason).toMatchObject({ message: expect.stringContaining('不可接单') });
    const rec = await store.get(pkg.taskId);
    expect(rec).toMatchObject({ status: 'claimed' });
    expect(['emp-01', 'emp-02', 'emp-03']).toContain(rec!.claimedBy);
  });

  it('publish/assign 状态机：draft 指定→发布→pending 改派→claim 后拒绝（与 sqlite 同语义）', async () => {
    const store = makeTasks();
    const pkg = parseTaskPackage(
      'taskId: MYSQL-ASSIGN\ntitle: 分派分离\nrepo: { url: "http://gitlab.inner.bank/x.git", branch: main }\ntasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]',
    );
    await store.add(pkg, { draft: true });
    const assigned = await store.assign(pkg.taskId, 'emp-01');
    expect(assigned.status).toBe('draft');
    expect(assigned.pkg.assignee).toBe('emp-01');
    const published = await store.publish(pkg.taskId);
    expect(published.status).toBe('pending');
    const reassigned = await store.assign(pkg.taskId, 'emp-02');
    expect(reassigned.pkg.assignee).toBe('emp-02');
    await store.claim(pkg.taskId, 'emp-02');
    await expect(store.assign(pkg.taskId, 'emp-03')).rejects.toThrow(/仅待发布\/待分派任务可指定员工/);
  });

  it('resumePlan：仅 failed 可续（→pending，失败项复位 skipped，原执行员工写回 assignee）', async () => {
    const store = makeTasks();
    const pkg = parseTaskPackage(
      'taskId: MYSQL-RESUME\ntitle: 计划续跑\nrepo: { url: "http://gitlab.inner.bank/x.git", branch: main }\ntasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]',
    );
    await store.add(pkg);
    await store.claim(pkg.taskId, 'emp-01');
    await store.markRunning(pkg.taskId);
    await store.finish(
      pkg.taskId,
      { status: 'done', reply: '第 2 项失败', turns: 3 },
      false,
      [
        { itemId: 't1', kind: 'dev', title: '开发', status: 'done' },
        { itemId: 't2', kind: 'test', title: '测试', status: 'failed' },
      ],
      't2',
    );
    const resumed = await store.resumePlan(pkg.taskId);
    expect(resumed.status).toBe('pending');
    expect(resumed.planProgress).toEqual([
      { itemId: 't1', kind: 'dev', title: '开发', status: 'done' },
      { itemId: 't2', kind: 'test', title: '测试', status: 'skipped' },
    ]);
    expect(resumed.failedItemId).toBeUndefined();
    expect(resumed.pkg.assignee).toBe('emp-01');
    await expect(store.resumePlan(pkg.taskId)).rejects.toThrow(/仅 failed 任务可续跑/);
  });

  it('同 id 事件重放不炸：warn 忽略只留首次，hash 链不受影响', async () => {
    const store = makeEvents();
    const ev = { id: 'mysql-sched-T1-1-aaaa', ts: 1000, taskId: 'T1', employeeId: 'emp-01', type: 'dispatch' as const, summary: '分派' };
    await store.append(ev);
    await expect(store.append({ ...ev, ts: 2000 })).resolves.toBeUndefined();
    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ts).toBe(1000);
    expect((await store.verifyIntegrity!()).ok).toBe(true);
  });

  it('并发 append 链不分叉（T3 评审必做项）：Promise.all 8 路并发 append，lockRead FOR UPDATE 串行化链尾，verifyIntegrity ok', async () => {
    const store = makeEvents();
    const evs = Array.from({ length: 8 }, (_, i) => ({
      id: `mysql-par-e${i}`, ts: 1000 + i, taskId: 'T1', employeeId: 'emp-01',
      type: 'tool_call' as const, summary: `并发事件 ${i}`,
    }));
    await Promise.all(evs.map((e) => store.append(e)));
    const report = await store.verifyIntegrity!();
    expect(report).toMatchObject({ ok: true, total: 8 });
    // 链确为一条：逐条 prev_hash = 前一条 hash（verifyIntegrity ok 已含此断言，这里再钉 seq 连续性）
    const rows = await store.list();
    expect(rows.map((e) => e.id).sort()).toEqual(evs.map((e) => e.id).sort());
  });
});

describe('SqlEventStore 存量旧库共存（P9-B）', () => {
  it('带退役前旧 event 表的库打开不回归：ensureSchema 建 ddw_events，新事件照常成链（存量数据迁移另行执行）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-sqlite-migrate-'));
    const dbPath = join(dir, 'ddw.sqlite');
    // 手工建退役前旧表（SqliteEventStore 时代的 event 表）
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE event (
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
      )
    `);
    old.close();

    const { store, driver } = await makeEventStore(dbPath);
    try {
      await store.append({ id: 'e-old', ts: 1000, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: '迁移后新事件' });
      const report = await store.verifyIntegrity!();
      expect(report).toMatchObject({ ok: true, total: 1 });
      expect(await store.list()).toHaveLength(1);
    } finally {
      await driver.close();
    }
  });
});

describe('SqlEventStore 重复事件容错（2026-09-05 实战）', () => {
  it('同 id 重放不炸进程：warn 忽略，原有事件与 hash 链不受影响', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-sqlite-dup-'));
    const { store, driver } = await makeEventStore(join(dir, 'ddw.sqlite'));
    try {
      const ev = { id: 'sched-T1-1-aaaa', ts: 1000, taskId: 'T1', employeeId: 'emp-01', type: 'dispatch' as const, summary: '分派' };
      await store.append(ev);
      await expect(store.append({ ...ev, ts: 2000 })).resolves.toBeUndefined(); // 重放不抛
      const rows = await store.list();
      expect(rows).toHaveLength(1); // 只保留首次落库
      expect(rows[0]!.ts).toBe(1000);
      expect((await store.verifyIntegrity!()).ok).toBe(true);
    } finally {
      await driver.close();
    }
  });
});

describe('SqlEventStore 链头快照（headsPath 显式传入）', () => {
  it('不传/传 null = 不支持快照（:memory: 语义）：snapshotHead 抛错；verifyIntegrity 跳过快照比对', async () => {
    const { store, driver } = await makeEventStore(':memory:');
    try {
      await store.append({ id: 'e1', ts: 1000, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: 'x' });
      await expect(store.snapshotHead!()).rejects.toThrow(/不支持链头快照/);
      expect(await store.verifyIntegrity!()).toEqual({ ok: true, total: 1 });
    } finally {
      await driver.close();
    }
  });

  it('传路径：快照追加写入库外文件，verifyIntegrity 带快照比对通过', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-sqlite-heads-'));
    const { store, driver } = await makeEventStore(join(dir, 'ddw.sqlite'));
    try {
      await store.append({ id: 'e1', ts: 1000, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: 'x' });
      await store.append({ id: 'e2', ts: 2000, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: 'y' });
      const head = await store.snapshotHead!();
      expect(head.id).toBe('e2');
      // 快照文件独立于库文件，内容为 jsonl 追加
      const text = await readFile(`${join(dir, 'ddw.sqlite')}.heads.jsonl`, 'utf8');
      expect(text.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(text)).toMatchObject({ id: 'e2' });
      const report = await store.verifyIntegrity!();
      expect(report.ok).toBe(true);
      expect(report.headSnapshot).toEqual({ ok: true, checked: 1 });
    } finally {
      await driver.close();
    }
  });
});
