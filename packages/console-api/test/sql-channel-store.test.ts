import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import { createMysqlDriver } from '../src/stores/sql/mysql-driver.js';
import type { SqlDriver } from '../src/stores/sql/driver.js';
import { SqlChannelStore } from '../src/stores/sql/sql-channel-store.js';
import type { NotificationChannelDef } from '../src/team/notifier.js';
import { mysqlTestUrl, resetMysqlTestDb } from './helpers/mysql.js';

const MYSQL_DB = 'ddw_test_chan_store'; // 各测试文件独立库名：vitest 并行下互不踩踏
const mysqlUrl = process.env.DDW_TEST_MYSQL_URL;
const d = mysqlUrl ? describe : describe.skip;

const def = (id: string, overrides: Partial<NotificationChannelDef> = {}): NotificationChannelDef =>
  ({ id, type: 'webhook', name: `渠道 ${id}`, webhookUrl: 'https://hook.local/notify', enabled: true, ...overrides });

interface Ctx { store: SqlChannelStore; driver: SqlDriver; cleanup: () => Promise<void>; }

function behaviorSuite(label: string, make: () => Promise<Ctx>): void {
  describe(`SqlChannelStore（通知渠道 Sql store，T5）${label}`, () => {
    it('空表 list → []；upsert 新增/同 id 覆盖；remove（存在 true / 不存在 false）', async () => {
      const { store, cleanup } = await make();
      try {
        expect(await store.list()).toEqual([]);
        await store.upsert(def('d1', { type: 'dingtalk', name: '钉钉' }));
        await store.upsert(def('w1', { type: 'wecom', name: '企微', enabled: false }));
        expect((await store.list()).map((c) => c.id)).toEqual(['d1', 'w1']);
        await store.upsert(def('d1', { type: 'dingtalk', name: '钉钉', enabled: false })); // 同 id 覆盖
        expect((await store.list()).find((c) => c.id === 'd1')?.enabled).toBe(false);
        expect(await store.remove('w1')).toBe(true);
        expect(await store.remove('w1')).toBe(false);
        expect((await store.list()).map((c) => c.id)).toEqual(['d1']);
      } finally { await cleanup(); }
    });

    it('upsert 校验（复用 validateChannelDef）：id/type/name/webhookUrl/enabled 非法 reject，不落库', async () => {
      const { store, cleanup } = await make();
      try {
        await expect(store.upsert(def('', { name: 'x' }))).rejects.toThrow(/id/);
        await expect(store.upsert(def('a', { type: 'sms' as never }))).rejects.toThrow(/type/);
        await expect(store.upsert(def('a', { name: ' ' }))).rejects.toThrow(/name/);
        await expect(store.upsert(def('a', { webhookUrl: 'ftp://x' }))).rejects.toThrow(/webhookUrl/);
        await expect(store.upsert({ ...def('a'), enabled: 'yes' as never })).rejects.toThrow(/enabled/);
        expect(await store.list()).toEqual([]); // 非法零落库
      } finally { await cleanup(); }
    });

    it('secret 随 doc 原样存取（钉钉加签 secret 往返保留；脱敏由 HTTP 层 redactChannel 负责）', async () => {
      const { store, cleanup } = await make();
      try {
        const ding = def('d1', {
          type: 'dingtalk', name: '钉钉',
          webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=x', secret: 'SECxxx',
        });
        await store.upsert(ding);
        const got = (await store.list()).find((c) => c.id === 'd1');
        expect(got?.secret).toBe('SECxxx');
      } finally { await cleanup(); }
    });
  });
}

behaviorSuite('sqlite :memory: 驱动', async () => {
  const driver = new SqliteDriver(':memory:');
  await driver.ensureSchema();
  return { store: new SqlChannelStore(driver), driver, cleanup: () => driver.close() };
});

// mysql 分支（spec 存储企业化）：设 DDW_TEST_MYSQL_URL 才跑（缺 env 整组 skip，离线安全）
d('SqlChannelStore mysql 分支（DDW_TEST_MYSQL_URL）', () => {
  let driver: SqlDriver;

  beforeAll(async () => {
    await resetMysqlTestDb(mysqlUrl!, MYSQL_DB);
    driver = await createMysqlDriver(mysqlTestUrl(mysqlUrl!, MYSQL_DB));
    await driver.ensureSchema();
  });
  afterAll(async () => { await driver?.close(); });

  afterEach(async () => { await driver.exec('DELETE FROM ddw_channels'); });

  behaviorSuite('mysql 驱动', async () => ({
    store: new SqlChannelStore(driver),
    driver,
    cleanup: async () => { await driver.exec('DELETE FROM ddw_channels'); },
  }));
});
