import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import { SqlTaskStore } from '../src/stores/sql/sql-task-store.js';
import { createMysqlDriver } from '../src/stores/sql/mysql-driver.js';
import { mysqlTestUrl, resetMysqlTestDb } from './helpers/mysql.js';
import { parseTaskPackage } from '@ddw/runtime';
import { readFile } from 'node:fs/promises';

const YAML = await readFile(new URL('../../../examples/task-package.example.yaml', import.meta.url), 'utf8');
const pkgOf = (id: string) => parseTaskPackage(YAML.replace('taskId: TASK-2026-0912-001', `taskId: ${id}`));

/** 迁移前的旧 ddw_tasks（= 现行 DDL 去掉 created_at 列）——存量库形状 */
const OLD_TASKS_DDL = `CREATE TABLE ddw_tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at INTEGER,
  pkg TEXT NOT NULL,
  result TEXT,
  plan_progress TEXT,
  failed_item_id TEXT,
  updated_at INTEGER NOT NULL
)`;

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined as unknown as string;
});

describe('ddw_tasks created_at 列迁移（2026-09-11 P1 治理批）', () => {
  it('sqlite：旧库 ensureSchema 自动补列并以 updated_at 近似回填；再跑幂等', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-migration-'));
    const dbPath = join(dir, 'ddw.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(OLD_TASKS_DDL);
    // 存量两行：updated_at 不同（近似入池时间）
    db.prepare("INSERT INTO ddw_tasks (id, status, pkg, updated_at) VALUES (?, 'done', '{}', 1000)").run('task-old-1');
    db.prepare("INSERT INTO ddw_tasks (id, status, pkg, updated_at) VALUES (?, 'done', '{}', 2000)").run('task-old-2');
    db.close();

    const driver = new SqliteDriver(dbPath);
    await driver.ensureSchema(); // 迁移发生处

    const cols = await driver.all<{ name: string }>('PRAGMA table_info(ddw_tasks)');
    expect(cols.some((c) => c.name === 'created_at')).toBe(true);
    const rows = await driver.all<{ id: string; created_at: number }>('SELECT id, created_at FROM ddw_tasks ORDER BY created_at ASC');
    // 回填 = updated_at（0 会把全部旧任务永排最前）
    expect(rows).toEqual([
      { id: 'task-old-1', created_at: 1000 },
      { id: 'task-old-2', created_at: 2000 },
    ]);

    // 幂等：再跑 ensureSchema 不重复 ALTER、不动已回填值
    await driver.ensureSchema();
    const again = await driver.all<{ id: string; created_at: number }>('SELECT id, created_at FROM ddw_tasks ORDER BY created_at ASC');
    expect(again).toEqual(rows);
    await driver.close();
  });

  it('sqlite：时间序分派——list 按 created_at ASC（同毫秒 id 保序），重提交刷新入池时间', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-migration-order-'));
    const driver = new SqliteDriver(join(dir, 'ddw.sqlite'));
    await driver.ensureSchema();
    const store = new SqlTaskStore(driver);

    const a = await store.add(pkgOf('TASK-A'));
    const b = await store.add(pkgOf('TASK-B'));
    expect(a.createdAt).toBeGreaterThan(0);
    expect(b.createdAt).toBeGreaterThanOrEqual(a.createdAt!);

    // 时间序：A 先入池先分派（同毫秒时 id 保序，仍 A 前 B 后）
    expect((await store.list()).map((r) => r.pkg.taskId)).toEqual(['TASK-A', 'TASK-B']);

    // 直接改库伪造时间序翻转：B 变最旧 → B 先分派（证明排序键确为 created_at 而非 taskId 字典序）
    await driver.run('UPDATE ddw_tasks SET created_at = 1 WHERE id = ?', [b.pkg.taskId]);
    expect((await store.list()).map((r) => r.pkg.taskId)).toEqual(['TASK-B', 'TASK-A']);

    // 重提交（同 taskId upsert）刷新 created_at → 回到队尾（重新排队语义）
    await store.add(pkgOf('TASK-B'));
    expect((await store.list()).map((r) => r.pkg.taskId)).toEqual(['TASK-A', 'TASK-B']);
    await driver.close();
  });

  // mysql 迁移路径与 sqlite 同构（information_schema 探测 → ALTER + 回填）；设 DDW_TEST_MYSQL_URL 才真跑
  const mysqlUrl = process.env.DDW_TEST_MYSQL_URL;
  if (mysqlUrl) {
    it('mysql：旧库补列 + 回填 + 幂等（真库验证 ALTER 方言）', async () => {
      const db = 'ddw_test_migration';
      await resetMysqlTestDb(mysqlUrl, db);
      const driver = await createMysqlDriver(mysqlTestUrl(mysqlUrl, db));
      // 手造旧表（现行 mysql DDL 去 created_at；resetMysqlTestDb 后库里无表）
      await driver.exec(`CREATE TABLE ddw_tasks (
        id VARCHAR(64) PRIMARY KEY,
        status VARCHAR(32) NOT NULL,
        claimed_by VARCHAR(64) NULL,
        claimed_at BIGINT NULL,
        pkg JSON NOT NULL,
        result JSON NULL,
        plan_progress JSON NULL,
        failed_item_id VARCHAR(64) NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await driver.run("INSERT INTO ddw_tasks (id, status, pkg, updated_at) VALUES ('task-old-1', 'done', '{}', 1000)");

      await driver.ensureSchema();
      const rows = await driver.all<{ created_at: number | string }>('SELECT created_at FROM ddw_tasks WHERE id = ?', ['task-old-1']);
      expect(Number(rows[0]!.created_at)).toBe(1000);

      await driver.ensureSchema(); // 幂等
      await driver.close();
    }, 30_000);
  }
});
