import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import { createMysqlDriver } from '../src/stores/sql/mysql-driver.js';
import type { SqlDriver } from '../src/stores/sql/driver.js';
import { SqlCapabilityStore } from '../src/stores/sql/sql-capability-store.js';
import { CAPABILITY_PRESETS } from '../src/team/capabilities.js';
import { mysqlTestUrl, resetMysqlTestDb } from './helpers/mysql.js';

const MYSQL_DB = 'ddw_test_cap_store'; // 各测试文件独立库名：vitest 并行下互不踩踏
const mysqlUrl = process.env.DDW_TEST_MYSQL_URL;
const d = mysqlUrl ? describe : describe.skip;

const def = () => ({ kind: 'scan', name: '安全扫描', tools: { builtin: ['bash'], mcp: [] }, enabled: true });

interface Ctx { store: SqlCapabilityStore; driver: SqlDriver; cleanup: () => Promise<void>; }

function behaviorSuite(label: string, make: () => Promise<Ctx>): void {
  describe(`SqlCapabilityStore（能力注册表 Sql store，T5）${label}`, () => {
    it('ensureSeed 首启写四类预置；表非空二次 seed 不覆盖（用户修改保留）', async () => {
      const { store, cleanup } = await make();
      try {
        await store.ensureSeed();
        const list = await store.list();
        expect(list.map((c) => c.kind).sort()).toEqual(['commit', 'dev', 'devops', 'test']); // 预置四类
        expect(list.find((c) => c.kind === 'devops')?.tools.mcp).toEqual(['deploy']);
        await store.upsert({ ...CAPABILITY_PRESETS[0]!, name: '开发编码改', enabled: false });
        await store.ensureSeed(); // 二次 seed 不覆盖用户修改
        const after = await store.list();
        expect(after.find((c) => c.kind === 'dev')?.name).toBe('开发编码改');
        expect(after.find((c) => c.kind === 'dev')?.enabled).toBe(false);
      } finally { await cleanup(); }
    });

    it('upsert 新增与修改；remove 删除（存在 true / 不存在 false）', async () => {
      const { store, cleanup } = await make();
      try {
        await store.ensureSeed();
        await store.upsert(def());
        expect((await store.list()).map((c) => c.kind)).toContain('scan');
        await store.upsert({ ...def(), name: '安全扫描2', enabled: false });
        const after = await store.list().then((l) => l.find((c) => c.kind === 'scan'));
        expect(after).toMatchObject({ name: '安全扫描2', enabled: false });
        expect(await store.remove('scan')).toBe(true);
        expect(await store.remove('scan')).toBe(false);
      } finally { await cleanup(); }
    });

    it('upsert 校验（复用 validateCapabilityDef）：kind/name 非空、builtin/mcp 数组与白名单、enabled 布尔；非法不落库', async () => {
      const { store, cleanup } = await make();
      try {
        await store.ensureSeed();
        await expect(store.upsert({ kind: '', name: 'x', tools: { builtin: [], mcp: [] }, enabled: true }))
          .rejects.toThrow(/kind 必须是非空字符串/);
        await expect(store.upsert({ kind: 'k', name: '', tools: { builtin: [], mcp: [] }, enabled: true }))
          .rejects.toThrow(/name 必须是非空字符串/);
        await expect(store.upsert({ kind: 'k', name: 'n', tools: { builtin: 'bash', mcp: [] } as never, enabled: true }))
          .rejects.toThrow(/tools\.builtin 必须是字符串数组/);
        await expect(store.upsert({ kind: 'k', name: 'n', tools: { builtin: ['nope'], mcp: [] }, enabled: true }))
          .rejects.toThrow(/tools\.builtin 含未知内置能力/);
        await expect(store.upsert({ kind: 'k', name: 'n', tools: { builtin: [], mcp: ['nope'] }, enabled: true }))
          .rejects.toThrow(/tools\.mcp 含未注册的工具包/);
        await expect(store.upsert({ ...def(), enabled: 'yes' as never })).rejects.toThrow(/enabled 必须是布尔值/);
        expect((await store.list()).map((c) => c.kind).sort()).toEqual(['commit', 'dev', 'devops', 'test']); // 非法零落库
      } finally { await cleanup(); }
    });

    it('allowedMcp 动态白名单 getter：getter 提供的 server 名合法；getter 收紧后原包被拒（每次实时取）', async () => {
      const { driver, cleanup } = await make();
      try {
        let allowed = new Set(['forge', 'jira-server']);
        const store = new SqlCapabilityStore(driver, () => allowed);
        await store.upsert({ kind: 'jira', name: 'Jira 查询', tools: { builtin: [], mcp: ['jira-server'] }, enabled: true });
        expect((await store.list()).find((c) => c.kind === 'jira')).toBeDefined();
        allowed = new Set(['forge']); // server 下线，白名单收紧
        await expect(store.upsert({ kind: 'jira', name: 'Jira 查询2', tools: { builtin: [], mcp: ['jira-server'] }, enabled: true }))
          .rejects.toThrow(/tools\.mcp 含未注册的工具包/);
      } finally { await cleanup(); }
    });
  });
}

behaviorSuite('sqlite :memory: 驱动', async () => {
  const driver = new SqliteDriver(':memory:');
  await driver.ensureSchema();
  return { store: new SqlCapabilityStore(driver), driver, cleanup: () => driver.close() };
});

// mysql 分支（spec 存储企业化）：设 DDW_TEST_MYSQL_URL 才跑（缺 env 整组 skip，离线安全）
d('SqlCapabilityStore mysql 分支（DDW_TEST_MYSQL_URL）', () => {
  let driver: SqlDriver;

  beforeAll(async () => {
    await resetMysqlTestDb(mysqlUrl!, MYSQL_DB);
    driver = await createMysqlDriver(mysqlTestUrl(mysqlUrl!, MYSQL_DB));
    await driver.ensureSchema();
  });
  afterAll(async () => { await driver?.close(); });

  afterEach(async () => { await driver.exec('DELETE FROM ddw_capabilities'); });

  behaviorSuite('mysql 驱动', async () => ({
    store: new SqlCapabilityStore(driver),
    driver,
    cleanup: async () => { await driver.exec('DELETE FROM ddw_capabilities'); },
  }));
});
