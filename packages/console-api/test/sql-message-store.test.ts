import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import { createMysqlDriver } from '../src/stores/sql/mysql-driver.js';
import type { SqlDriver } from '../src/stores/sql/driver.js';
import { SqlMessageStore } from '../src/stores/sql/sql-message-store.js';
import { mysqlTestUrl, resetMysqlTestDb } from './helpers/mysql.js';

/** 测试工厂：makeStore(driver) 统一入口；行为断言抽 behaviorSuite，sqlite / mysql 各跑一遍（Task 4 风格） */
const MYSQL_DB = 'ddw_test_messages'; // 各测试文件独立库名：vitest 并行下互不踩踏
const mysqlUrl = process.env.DDW_TEST_MYSQL_URL;
const d = mysqlUrl ? describe : describe.skip;

interface Ctx { store: SqlMessageStore; driver: SqlDriver; cleanup: () => Promise<void>; }

function behaviorSuite(label: string, make: () => Promise<Ctx>): void {
  describe(`SqlMessageStore（消息中心 Sql store，T6）${label}`, () => {
    it('add 补齐 id/createdAt；unreadCount/markRead；list 最新在前 + unreadOnly；markAllRead 只补未读', async () => {
      const { store, driver, cleanup } = await make();
      // 表无自增列，同毫秒 add 打平 created_at 时由 id（随机 uuid）决序——
      // mock Date.now 单调递增保证「最新在前」断言确定性（File 为严格插入序，Sql 同毫秒内序不保证）
      const now = vi.spyOn(Date, 'now').mockImplementation(() => 1_700_000_000_000 + (mockTick++ * 1000));
      try {
        const m1 = await store.add({ type: 'task_done', title: '任务 t1 执行完成', summary: 'r1', taskId: 't1' });
        await store.add({ type: 'task_failed', title: '任务 t2 执行失败', summary: 'r2', taskId: 't2' });
        await store.add({ type: 'review_required', title: '任务 t3 待人工放行', summary: 'r3', taskId: 't3', employeeId: 'emp-01' });

        // add 补齐 id/createdAt，readAt 缺省
        expect(m1.id).toBeTypeOf('string');
        expect(m1.createdAt).toBeTypeOf('number');
        expect(m1.readAt).toBeUndefined();
        expect(await store.unreadCount()).toBe(3);

        // markRead 一条：unread 2、readAt 落定、窄列 read 同步置 1、已读记录仍在
        expect(await store.markRead(m1.id)).toBe(true);
        expect(await store.unreadCount()).toBe(2);
        const readAtBefore = (await store.list()).find((m) => m.id === m1.id)!.readAt;
        expect(readAtBefore).toBeTypeOf('number');
        expect((await driver.all<{ read_col: unknown }>('SELECT `read` AS read_col FROM ddw_messages WHERE id = ?', [m1.id]))[0]!.read_col)
          .toBe(1);

        // 最新在前（list ORDER BY created_at DESC）
        expect((await store.list()).map((m) => m.taskId)).toEqual(['t3', 't2', 't1']);
        // unreadOnly 只回未读（保持最新在前）
        expect((await store.list({ unreadOnly: true })).map((m) => m.taskId)).toEqual(['t3', 't2']);

        // markAllRead：只补未读的 readAt，返回标记条数；先读的那条 readAt 不被覆盖
        expect(await store.markAllRead()).toBe(2);
        expect(await store.unreadCount()).toBe(0);
        expect(await store.list({ unreadOnly: true })).toEqual([]);
        expect(await store.list()).toHaveLength(3);
        expect((await store.list()).find((m) => m.id === m1.id)!.readAt).toBe(readAtBefore);
      } finally {
        now.mockRestore();
        await cleanup();
      }
    });

    it('type/q 过滤在 JS 层做（MySQL JSON 列转字符串带空格，doc LIKE 字面量跨方言不可靠，2026-09-10）', async () => {
      const { store, cleanup } = await make();
      try {
        await store.add({ type: 'task_done', title: '任务 a 执行完成', summary: '已归档', taskId: 'task-a' });
        await store.add({ type: 'task_failed', title: '任务 b 执行失败', summary: '构建失败', taskId: 'task-b' });
        await store.add({ type: 'review_required', title: '任务 c 待人工放行', summary: '等待复核', taskId: 'task-c' });

        // type 精确过滤
        expect((await store.list({ type: 'task_failed' })).map((m) => m.taskId)).toEqual(['task-b']);
        // q 命中标题/摘要/任务 id（大小写不敏感）
        expect((await store.list({ q: '放行' })).map((m) => m.taskId)).toEqual(['task-c']);
        expect((await store.list({ q: 'TASK-B' })).map((m) => m.taskId)).toEqual(['task-b']);
        // 组合：type + q 交集为空
        expect(await store.list({ type: 'task_done', q: '失败' })).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it('1000 条滚动删除：add 1001 条丢最旧，表内恰 1000 条且最新在前；续 add 继续滚', async () => {
      const { store, driver, cleanup } = await make();
      // 同毫秒 add 时 created_at 打平，序由 id 决定不可测——mock Date.now 单调递增保证确定性
      const now = vi.spyOn(Date, 'now').mockImplementation(() => 1_700_000_000_000 + (mockTick++ * 1000));
      try {
        for (let i = 0; i <= 1000; i++) {
          await store.add({ type: 'task_done', title: `t${i}`, summary: '', taskId: 'x' });
        }
        const all = await store.list();
        expect(all).toHaveLength(1000);
        expect(all[0]!.title).toBe('t1000');
        expect(all[999]!.title).toBe('t1');
        expect(all.find((m) => m.title === 't0')).toBeUndefined();
        expect(await store.unreadCount()).toBe(1000);
        // 表内行数恰 1000（滚动删除真删行，非只过滤展示）
        const count = await driver.all<{ n: unknown }>('SELECT COUNT(*) AS n FROM ddw_messages');
        expect(Number(count[0]!.n)).toBe(1000);

        // 续 add：窗口前移，t1 被挤出
        await store.add({ type: 'task_done', title: 't1001', summary: '', taskId: 'x' });
        const after = await store.list();
        expect(after).toHaveLength(1000);
        expect(after[0]!.title).toBe('t1001');
        expect(after.find((m) => m.title === 't1')).toBeUndefined();
        expect(after.find((m) => m.title === 't2')).toBeDefined(); // t2 仍在
      } finally {
        now.mockRestore();
        await cleanup();
      }
    });

    it('markRead 不存在的 id 返回 false；已读重复 markRead 幂等 true 且 readAt 不重写', async () => {
      const { store, cleanup } = await make();
      try {
        const m = await store.add({ type: 'task_failed', title: '任务 t1 执行失败', summary: 'r', taskId: 't1' });
        expect(await store.markRead(m.id)).toBe(true);
        const firstReadAt = (await store.list()).find((x) => x.id === m.id)!.readAt;
        expect(await store.markRead(m.id)).toBe(true); // 幂等
        expect((await store.list()).find((x) => x.id === m.id)!.readAt).toBe(firstReadAt);
        expect(await store.markRead('nope')).toBe(false);
      } finally { await cleanup(); }
    });

    it('add 允许调用方指定 id；doc 往返 employeeId 等字段无损', async () => {
      const { store, cleanup } = await make();
      try {
        const rec = await store.add({
          id: 'custom-msg-1', type: 'skill_pending', title: 'Skill 待审查', summary: 's',
          taskId: 'T1', employeeId: 'emp-02',
        });
        expect(rec.id).toBe('custom-msg-1');
        const got = (await store.list())[0]!;
        expect(got).toMatchObject({
          id: 'custom-msg-1', type: 'skill_pending', title: 'Skill 待审查',
          taskId: 'T1', employeeId: 'emp-02',
        });
        expect(got.readAt).toBeUndefined();
      } finally { await cleanup(); }
    });
  });
}

let mockTick = 0;

behaviorSuite('sqlite :memory: 驱动', async () => {
  const driver = new SqliteDriver(':memory:');
  await driver.ensureSchema();
  return { store: new SqlMessageStore(driver), driver, cleanup: () => driver.close() };
});

// mysql 分支（spec 存储企业化）：设 DDW_TEST_MYSQL_URL 才跑（缺 env 整组 skip，离线安全）
d('SqlMessageStore mysql 分支（DDW_TEST_MYSQL_URL）', () => {
  let driver: SqlDriver;

  beforeAll(async () => {
    await resetMysqlTestDb(mysqlUrl!, MYSQL_DB); // DROP/CREATE 测试库（防误指生产库）
    driver = await createMysqlDriver(mysqlTestUrl(mysqlUrl!, MYSQL_DB));
    await driver.ensureSchema();
  });
  afterAll(async () => { await driver?.close(); }); // 库可留，表数据即弃

  afterEach(async () => { await driver.exec('DELETE FROM ddw_messages'); });

  behaviorSuite('mysql 驱动', async () => ({
    store: new SqlMessageStore(driver),
    driver,
    cleanup: async () => { await driver.exec('DELETE FROM ddw_messages'); },
  }));
});
