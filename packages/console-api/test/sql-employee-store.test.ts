import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import { createMysqlDriver } from '../src/stores/sql/mysql-driver.js';
import type { SqlDriver } from '../src/stores/sql/driver.js';
import { SqlEmployeeStore } from '../src/stores/sql/sql-employee-store.js';
import { mysqlTestUrl, resetMysqlTestDb } from './helpers/mysql.js';

/** 测试工厂：makeStore(driver) 统一入口；行为断言抽 behaviorSuite，sqlite / mysql 各跑一遍（Task 4 风格） */
const MYSQL_DB = 'ddw_test_emp_store'; // 各测试文件独立库名：vitest 并行下互不踩踏
const mysqlUrl = process.env.DDW_TEST_MYSQL_URL;
const d = mysqlUrl ? describe : describe.skip;

const rec = () => ({
  id: 'emp-01', name: '张三', roles: ['后端开发'],
  capabilities: ['dev', 'commit'], enabled: true, createdAt: 1_700_000_000_000,
});

/** 旧档 doc 直插（绕过 upsert，模拟存量数据）：经读路径 normalizeStored 归一 */
async function insertLegacyDoc(driver: SqlDriver, legacy: unknown): Promise<void> {
  await driver.run(
    'INSERT INTO ddw_employees (id, doc, updated_at, enabled) VALUES (?, ?, ?, 1)',
    [(legacy as { id: string }).id, JSON.stringify(legacy), Date.now()],
  );
}

interface Ctx { store: SqlEmployeeStore; driver: SqlDriver; cleanup: () => Promise<void>; }

function behaviorSuite(label: string, make: () => Promise<Ctx>): void {
  describe(`SqlEmployeeStore（员工档案 Sql store，T5）${label}`, () => {
    it('upsert 新增/修改；list/get/setEnabled（停用不物理删）；setEnabled 不存在 → null', async () => {
      const { store, cleanup } = await make();
      try {
        await store.upsert(rec());
        expect((await store.list()).map((e) => e.id)).toEqual(['emp-01']);
        await store.upsert({ ...rec(), name: '张三丰' });
        expect((await store.get('emp-01'))?.name).toBe('张三丰');
        const disabled = await store.setEnabled('emp-01', false);
        expect(disabled?.enabled).toBe(false);
        expect(await store.get('emp-01')).toBeDefined(); // 停用≠删除
        expect(await store.setEnabled('nope', false)).toBeNull();
      } finally { await cleanup(); }
    });

    it('seedFrom：capabilities 空=全部可用、enabled=true；表非空二次 seed 不覆盖', async () => {
      const { store, cleanup } = await make();
      try {
        await store.seedFrom([{ id: 'emp-01', name: '张三', role: '后端', skills: ['backend'] }]);
        const first = await store.get('emp-01');
        expect(first?.capabilities).toEqual([]);
        expect(first?.enabled).toBe(true);
        expect(first?.roles).toEqual(['后端']);
        await store.upsert({ ...rec(), name: '后台改名' });
        await store.seedFrom([{ id: 'emp-02', name: '李四', role: '测试', skills: ['test'] }]);
        expect((await store.get('emp-01'))?.name).toBe('后台改名'); // 二次 seed 不覆盖
        expect((await store.get('emp-02'))).toBeNull(); // 表非空整组跳过，不写入新档
      } finally { await cleanup(); }
    });

    it('读路径 normalizeStored 复用：旧单值 role 剥离归一为 roles；roles 逐项 trim + 空项剔除', async () => {
      const { store, driver, cleanup } = await make();
      try {
        await insertLegacyDoc(driver, {
          id: 'old1', name: '旧档', role: ' backend ', skills: ['backend'], skillCategories: ['x'],
          capabilities: [], enabled: true, createdAt: 1,
        });
        const got = (await store.list())[0]!;
        expect(got.roles).toEqual(['backend']); // 单值 role trim 后包装
        expect((got as unknown as { role?: string }).role).toBeUndefined(); // 旧键剥离
        expect(got.skills).toEqual(['backend']); // 退役字段原样保留（旧档读入不炸）
      } finally { await cleanup(); }
    });

    it('脏档警告：roles 空聚合 warn 一次（同 id 不重复告警），不抛错不阻断', async () => {
      const { store, driver, cleanup } = await make();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await insertLegacyDoc(driver, { id: 'b2', name: '脏员工', roles: ['  ', ''], capabilities: [], enabled: true, createdAt: 2 });
        await store.upsert({ ...rec(), roles: [' 后端开发 ', '   ', '前端开发'] });
        const list = await store.list();
        expect(list.find((r) => r.id === 'emp-01')?.roles).toEqual(['后端开发', '前端开发']); // trim 归一
        expect(list.find((r) => r.id === 'b2')?.roles).toEqual([]); // 脏档保留记录，不丢弃
        expect(warn).toHaveBeenCalledTimes(1); // 聚合一条
        const msg = warn.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(msg).toContain('b2');
        expect(msg).toContain('脏员工');
        expect(msg).toMatch(/roles/);
        await store.list();
        expect(warn).toHaveBeenCalledTimes(1); // 同 id 每进程只告警一次（等价 File load 缓存语义）
      } finally {
        warn.mockRestore();
        await cleanup();
      }
    });
  });
}

behaviorSuite('sqlite :memory: 驱动', async () => {
  const driver = new SqliteDriver(':memory:');
  await driver.ensureSchema();
  return { store: new SqlEmployeeStore(driver), driver, cleanup: () => driver.close() };
});

// mysql 分支（spec 存储企业化）：设 DDW_TEST_MYSQL_URL 才跑（缺 env 整组 skip，离线安全）
d('SqlEmployeeStore mysql 分支（DDW_TEST_MYSQL_URL）', () => {
  let driver: SqlDriver;

  beforeAll(async () => {
    await resetMysqlTestDb(mysqlUrl!, MYSQL_DB); // DROP/CREATE 测试库（防误指生产库）
    driver = await createMysqlDriver(mysqlTestUrl(mysqlUrl!, MYSQL_DB));
    await driver.ensureSchema();
  });
  afterAll(async () => { await driver?.close(); }); // 库可留，表数据即弃

  afterEach(async () => { await driver.exec('DELETE FROM ddw_employees'); });

  behaviorSuite('mysql 驱动', async () => ({
    store: new SqlEmployeeStore(driver),
    driver,
    cleanup: async () => { await driver.exec('DELETE FROM ddw_employees'); },
  }));
});
