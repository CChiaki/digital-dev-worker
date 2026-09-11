import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import { createMysqlDriver } from '../src/stores/sql/mysql-driver.js';
import type { SqlDriver } from '../src/stores/sql/driver.js';
import { TABLES } from '../src/stores/sql/driver.js';
import { DDL } from '../src/stores/sql/schema.js';
import { SqlEventStore } from '../src/stores/sql/sql-event-store.js';
import { SqlEmployeeStore } from '../src/stores/sql/sql-employee-store.js';
import { mysqlTestUrl, resetMysqlTestDb } from './helpers/mysql.js';

const EXPECTED_INDEXES = [
  'idx_ddw_tasks_status',
  'idx_ddw_events_task_id',
  'idx_ddw_events_employee_id',
  'idx_ddw_events_type',
  'idx_ddw_events_ts',
  'idx_ddw_employees_enabled',
  'idx_ddw_skills_category_id',
  'idx_ddw_skills_status',
  'idx_ddw_messages_read',
  'idx_ddw_messages_created_at',
  'idx_ddw_generations_created_at',
  'idx_ddw_push_logs_created_at',
];

/**
 * 双驱动核心断言（存储企业化 Task 4）：10 表 + 索引 / CRUD / tx 提交回滚 / upsert 覆盖 /
 * resetCols 清残留 / JSON 往返，sqlite 与 mysql 跑同一套用例——方言差异只允许存在于驱动内。
 * makeCtx 每用例给一个建好 schema 的驱动；tables/indexes 为方言各自的元数据查询。
 */
interface DriverCtx {
  driver: SqlDriver;
  tables: () => Promise<string[]>;
  indexes: () => Promise<string[]>;
  dispose: () => Promise<void>;
}

function driverCoreSuite(label: string, makeCtx: () => Promise<DriverCtx>): void {
  describe(`SqlDriver core（${label}）`, () => {
    let ctx: DriverCtx;
    beforeEach(async () => {
      ctx = await makeCtx();
    });
    afterEach(async () => {
      await ctx.dispose();
    });

    it('ensureSchema 幂等建全 10 表 + 索引（二次执行不炸）', async () => {
      const d = ctx.driver;
      await d.ensureSchema(); // 二次执行不炸 = 幂等
      expect((await ctx.tables()).sort()).toEqual([...TABLES].sort());
      expect((await ctx.indexes()).sort()).toEqual([...EXPECTED_INDEXES].sort());
    });

    it('基本 CRUD（含 exec 带参路径）', async () => {
      const d = ctx.driver;
      const pkg = { taskId: 'T-1', title: 'x' };
      const inserted = await d.run(
        'INSERT INTO ddw_tasks (id, status, pkg, updated_at) VALUES (?, ?, ?, ?)',
        ['T-1', 'pending', d.encodeJson(pkg), 123],
      );
      expect(inserted.affected).toBe(1);
      const updated = await d.run('UPDATE ddw_tasks SET status = ? WHERE id = ?', ['claimed', 'T-1']);
      expect(updated.affected).toBe(1);
      const rows = await d.all<{ id: string; status: string; pkg: unknown }>(
        'SELECT id, status, pkg FROM ddw_tasks WHERE id = ?',
        ['T-1'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('claimed');
      expect(d.decodeJson<{ taskId: string }>(rows[0]!.pkg)).toEqual(pkg);
      await d.exec('DELETE FROM ddw_tasks WHERE id = ?', ['T-1']);
      expect(await d.all('SELECT id FROM ddw_tasks WHERE id = ?', ['T-1'])).toHaveLength(0);
    });

    it('tx 内成功提交、抛错回滚（回滚后查无此行且连接可用）并透传返回值', async () => {
      const d = ctx.driver;
      // 提交
      const ret = await d.tx(async () => {
        await d.run("INSERT INTO ddw_tasks (id, status, pkg, updated_at) VALUES ('T-COMMIT', 'pending', '{}', 1)");
        return 42;
      });
      expect(ret).toBe(42);
      expect(await d.all("SELECT id FROM ddw_tasks WHERE id = 'T-COMMIT'")).toHaveLength(1);
      // 回滚
      await expect(
        d.tx(async () => {
          await d.run("INSERT INTO ddw_tasks (id, status, pkg, updated_at) VALUES ('T-ROLLBACK', 'pending', '{}', 1)");
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await d.all("SELECT id FROM ddw_tasks WHERE id = 'T-ROLLBACK'")).toHaveLength(0);
      // 回滚后连接仍可用（无悬挂事务）
      await d.run("INSERT INTO ddw_tasks (id, status, pkg, updated_at) VALUES ('T-AFTER', 'pending', '{}', 1)");
      expect(await d.all("SELECT id FROM ddw_tasks WHERE id = 'T-AFTER'")).toHaveLength(1);
    });

    it('并发 tx 不碰撞：两事务并发启动各自提交落库（T7 评审 P1：sqlite 串行队列）', async () => {
      const d = ctx.driver;
      // 现状（修前）：sqlite 单连接上两个 BEGIN 并发启动 → cannot start a transaction within a transaction
      await Promise.all([
        d.tx(async () => {
          await d.run("INSERT INTO ddw_tasks (id, status, pkg, updated_at) VALUES ('T-CONC-A', 'pending', '{}', 1)");
        }),
        d.tx(async () => {
          await d.run("INSERT INTO ddw_tasks (id, status, pkg, updated_at) VALUES ('T-CONC-B', 'pending', '{}', 1)");
        }),
      ]);
      const rows = await d.all<{ id: string }>(
        "SELECT id FROM ddw_tasks WHERE id IN ('T-CONC-A', 'T-CONC-B') ORDER BY id",
      );
      expect(rows.map((r) => r.id)).toEqual(['T-CONC-A', 'T-CONC-B']);
    });

    it('tx 抛错回滚后队列不断链：后续 tx 照常提交（T7 评审 P1：失败归一防锁死）', async () => {
      const d = ctx.driver;
      // 第二个事务在第一个失败事务**之后入队**（不等第一个 settle），回滚失败不得卡死队列
      const failing = d.tx(async () => {
        await d.run("INSERT INTO ddw_tasks (id, status, pkg, updated_at) VALUES ('T-FAIL', 'pending', '{}', 1)");
        throw new Error('first-boom');
      });
      const following = d.tx(async () => {
        await d.run("INSERT INTO ddw_tasks (id, status, pkg, updated_at) VALUES ('T-NEXT', 'pending', '{}', 1)");
      });
      await expect(failing).rejects.toThrow('first-boom');
      await following; // 队列断链则此 fn 永不执行（或 BEGIN 未开），此行落库即为队列健康
      expect(await d.all("SELECT id FROM ddw_tasks WHERE id = 'T-NEXT'")).toHaveLength(1);
      expect(await d.all("SELECT id FROM ddw_tasks WHERE id = 'T-FAIL'")).toHaveLength(0); // 回滚生效
    });

    it('upsertSql 真跑两连插覆盖', async () => {
      const d = ctx.driver;
      const sql = d.upsertSql('ddw_tasks', 'id', ['status', 'pkg', 'updated_at']);
      await d.run(sql, ['T-U', 'pending', d.encodeJson({ taskId: 'T-U' }), 1]);
      await d.run(sql, ['T-U', 'claimed', d.encodeJson({ taskId: 'T-U', v: 2 }), 2]);
      const rows = await d.all<{ status: string; pkg: unknown; updated_at: number }>(
        'SELECT status, pkg, updated_at FROM ddw_tasks WHERE id = ?',
        ['T-U'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('claimed');
      expect(rows[0]!.updated_at).toBe(2);
      expect(d.decodeJson<{ v?: number }>(rows[0]!.pkg).v).toBe(2);
    });

    it('resetCols：真跑清空残留列（T2 评审 P1——重提交清残留）', async () => {
      const d = ctx.driver;
      const sql = d.upsertSql('ddw_tasks', 'id', ['pkg', 'status', 'updated_at'], ['claimed_by', 'claimed_at', 'result']);
      // 第一插带 claimed_by，冲突第二插 resetCols 清空
      await d.run(
        "INSERT INTO ddw_tasks (id, pkg, status, claimed_by, claimed_at, result, updated_at) VALUES ('T-RESET', '{}', 'done', 'emp-01', 111, '{}', 1)",
      );
      await d.run(sql, ['T-RESET', d.encodeJson({ taskId: 'T-RESET' }), 'pending', 2]);
      const rows = await d.all<{ status: string; claimed_by: string | null; claimed_at: number | null; result: unknown; updated_at: number }>(
        'SELECT status, claimed_by, claimed_at, result, updated_at FROM ddw_tasks WHERE id = ?',
        ['T-RESET'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('pending');
      expect(rows[0]!.claimed_by).toBeNull();
      expect(rows[0]!.claimed_at).toBeNull();
      expect(rows[0]!.result).toBeNull();
      expect(rows[0]!.updated_at).toBe(2);
    });

    it('encodeJson/decodeJson 往返；非 string 原样返回（防御 mysql2 行为差异）', async () => {
      const d = ctx.driver;
      const v = { a: 1, b: ['x', 'y'], c: { d: null } };
      if (label === 'mysql') {
        // T8 评审必修：mysql 双重编码——JSON 列存字符串标量（字符串不做键重排，插入序保得住审计链
        // canonical 的键序敏感 hash）。encodeJson 产出外层 JSON 字符串；decodeJson 只解内层一层，
        // 外层由 mysql2 对 JSON 列的自动 parse 解开（真库往返见下方 mysql 分支用例）。
        expect(d.encodeJson(v)).toBe(JSON.stringify(JSON.stringify(v)));
        expect(d.decodeJson<string>(d.encodeJson(v))).toBe(JSON.stringify(v));
      } else {
        expect(d.encodeJson(v)).toBe(JSON.stringify(v));
        expect(d.decodeJson<typeof v>(d.encodeJson(v))).toEqual(v);
      }
      const obj = { already: 'parsed' };
      expect(d.decodeJson(obj)).toBe(obj);
      expect(d.decodeJson(42)).toBe(42);
      expect(d.decodeJson(null)).toBe(null);
    });
  });
}

// ---------- sqlite 驱动（每用例独立 :memory: 库） ----------

driverCoreSuite('sqlite', async () => {
  const driver = new SqliteDriver(':memory:');
  await driver.ensureSchema();
  return {
    driver,
    tables: async () =>
      (await driver.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ddw_%'",
      )).map((r) => r.name),
    indexes: async () =>
      (await driver.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_ddw_%'",
      )).map((r) => r.name),
    dispose: () => driver.close(),
  };
});

describe('SqlDriver sqlite 方言断言', () => {
  it('upsertSql 产出含 ON CONFLICT(id) DO UPDATE；lockRead 原样返回（sqlite 不支持 FOR UPDATE）', () => {
    const d = new SqliteDriver(':memory:');
    const sql = d.upsertSql('ddw_tasks', 'id', ['status', 'pkg', 'updated_at']);
    expect(sql).toContain('ON CONFLICT(id) DO UPDATE');
    expect(d.lockRead('SELECT 1')).toBe('SELECT 1');
  });
});

describe('SqlDriver schema', () => {
  it('DDL 双方言齐备：mysql 侧 10 表字面量非空', () => {
    expect(DDL.sqlite.length).toBeGreaterThan(0);
    expect(DDL.mysql.length).toBeGreaterThan(0);
    for (const t of TABLES) {
      expect(DDL.sqlite.some((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${t}`))).toBe(true);
      expect(DDL.mysql.some((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${t}`))).toBe(true);
    }
  });
});

// ---------- mysql 驱动（设 DDW_TEST_MYSQL_URL 才真跑；测试库强制 ddw_test，缺 env 整组 skip） ----------

const mysqlUrl = process.env.DDW_TEST_MYSQL_URL;
const dmysql = mysqlUrl ? describe : describe.skip;

const MYSQL_DB = 'ddw_test_driver'; // 各测试文件独立库名：vitest 并行下互不踩踏

dmysql('SqlDriver mysql 分支（DDW_TEST_MYSQL_URL）', () => {
  let driver: SqlDriver;

  beforeAll(async () => {
    await resetMysqlTestDb(mysqlUrl!, MYSQL_DB); // DROP/CREATE 测试库（防误指生产库：库名强制改写）
    driver = await createMysqlDriver(mysqlTestUrl(mysqlUrl!, MYSQL_DB));
    await driver.ensureSchema();
  });
  afterAll(async () => {
    await driver.close(); // 库可留，表数据即弃
  });

  // 共享驱动 + 每用例清表隔离
  driverCoreSuite('mysql', async () => {
    for (const t of TABLES) await driver.exec(`DELETE FROM ${t}`);
    return {
      driver,
      tables: async () =>
        (await driver.all<{ name: string }>(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'ddw_%'",
        )).map((r) => r.name),
      indexes: async () =>
        (await driver.all<{ name: string }>(
          "SELECT DISTINCT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name LIKE 'idx_ddw_%'",
        )).map((r) => r.name),
      dispose: async () => {},
    };
  });

  it('upsertSql mysql 方言：ON DUPLICATE KEY UPDATE col = VALUES(col) + resetCols col = NULL（兼容 5.7 不用 alias）', () => {
    const sql = driver.upsertSql('ddw_tasks', 'id', ['pkg', 'status', 'updated_at'], ['claimed_by', 'result']);
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('pkg = VALUES(pkg)');
    expect(sql).toContain('claimed_by = NULL');
    expect(sql).toContain('result = NULL');
    expect(sql).not.toContain('excluded.');
  });

  it('lockRead 追加 FOR UPDATE（并发 append 链尾锁定读，防 hash 链分叉）', () => {
    expect(driver.lockRead('SELECT hash FROM ddw_events ORDER BY seq DESC LIMIT 1')).toBe(
      'SELECT hash FROM ddw_events ORDER BY seq DESC LIMIT 1 FOR UPDATE',
    );
  });

  it('事务体内语句经 txConn 路由：tx 内写入立即可见（同连接），提交后池连接可见', async () => {
    await driver.exec('DELETE FROM ddw_tasks');
    await driver.tx(async () => {
      await driver.run("INSERT INTO ddw_tasks (id, status, pkg, updated_at) VALUES ('T-TXCONN', 'pending', '{}', 1)");
      // tx 内（同 txConn）可见
      expect(await driver.all("SELECT id FROM ddw_tasks WHERE id = 'T-TXCONN'")).toHaveLength(1);
    });
    // 提交后池连接可见
    expect(await driver.all("SELECT id FROM ddw_tasks WHERE id = 'T-TXCONN'")).toHaveLength(1);
  });

  // T8 评审必修：MySQL JSON 列对对象键排序存储，插入序丢失 → 事件 payload 若存对象，
  // verifyIntegrity 重算 canonical hash（键序敏感）必断链。encodeJson 双重编码后字符串标量不重排，
  // 链不断。修前此组必红（brokenAt + 键序被 MySQL 重排）。
  it('乱序多键 payload 事件 append → verifyIntegrity ok + list 读回原键序对象', async () => {
    await driver.exec('DELETE FROM ddw_events');
    const store = new SqlEventStore(driver, { headsPath: null });
    const payload = { bb: 2, a: 1, 混中文: 3 };
    await store.append({
      id: 'ev-jsonkey-1', ts: 1, taskId: 'T-JSONKEY', employeeId: 'emp-fix', type: 'report',
      summary: '键序敏感 payload', payload,
    });
    const report = await store.verifyIntegrity();
    expect(report).toMatchObject({ ok: true, total: 1 });
    const events = await store.list({ taskId: 'T-JSONKEY' });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual(payload);
    // decodeJson 还原的不只是深相等，还有原插入键序（MySQL 重排则此断言红）
    expect(Object.keys(events[0]!.payload as Record<string, unknown>)).toEqual(Object.keys(payload));
  });

  it('store 层对象 doc 直写往返：employee upsert → get 深相等（双编对其余 store 透明）', async () => {
    await driver.exec('DELETE FROM ddw_employees');
    const store = new SqlEmployeeStore(driver);
    const rec = {
      id: 'emp-jsonkey', name: '小键', roles: ['后端开发', '测试'], capabilities: ['dev'],
      enabled: true, createdAt: 1,
    };
    await store.upsert(rec);
    expect(await store.get('emp-jsonkey')).toEqual(rec);
    // doc 列真身：外层 JSON 字符串标量（双编证据——修前为对象/单层文本，MySQL 读回已重排键序）
    const rows = await driver.all<{ doc: unknown }>('SELECT doc FROM ddw_employees WHERE id = ?', ['emp-jsonkey']);
    expect(typeof rows[0]!.doc).toBe('string');
    expect(JSON.parse(rows[0]!.doc as string)).toEqual(rec); // 解外层得内层 JSON 文本
  });
});
