import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import { createMysqlDriver } from '../src/stores/sql/mysql-driver.js';
import type { SqlDriver } from '../src/stores/sql/driver.js';
import { SqlSkillStore } from '../src/stores/sql/sql-skill-store.js';
import { newSkillId, type SkillRecord } from '../src/team/skill-store.js';
import { mysqlTestUrl, resetMysqlTestDb } from './helpers/mysql.js';

/** 测试工厂：makeStore(driver) 统一入口；行为断言抽 behaviorSuite，sqlite / mysql 各跑一遍（Task 4 风格） */
const MYSQL_DB = 'ddw_test_skills'; // 各测试文件独立库名：vitest 并行下互不踩踏
const mysqlUrl = process.env.DDW_TEST_MYSQL_URL;
const d = mysqlUrl ? describe : describe.skip;

const rec = (over: Partial<SkillRecord> = {}): SkillRecord => ({
  id: newSkillId(), categoryId: 'backend', name: '接口异常码规范', description: 'REST 异常码约定',
  type: 'knowledge', content: '所有接口异常码以 E 开头…', status: 'pending', source: 'manual', createdAt: Date.now(),
  ...over,
});

interface Ctx { store: SqlSkillStore; driver: SqlDriver; cleanup: () => Promise<void>; }

function behaviorSuite(label: string, make: () => Promise<Ctx>): void {
  describe(`SqlSkillStore（Skill 库 Sql store，T6）${label}`, () => {
    it('ensureSeed：categories 空表写入内置五类；表非空不覆盖（幂等）', async () => {
      const { store, cleanup } = await make();
      try {
        await store.ensureSeed();
        const cats = await store.listCategories();
        expect([...cats.map((c) => c.id)].sort()).toEqual(['backend', 'devops', 'frontend', 'security', 'testing']);
        expect(cats.find((c) => c.id === 'backend')?.name).toBe('后端开发');
        expect(cats.find((c) => c.id === 'security')?.name).toBe('安全合规');
        // skills 空表 seed 不写 skill
        expect(await store.listSkills()).toEqual([]);
        // 已有分类（含用户自建）不被 seed 覆盖/回填
        await store.upsertCategory({ id: 'custom', name: '自定义' });
        await store.ensureSeed();
        const after = await store.listCategories();
        expect(after.find((c) => c.id === 'custom')?.name).toBe('自定义');
        expect(after).toHaveLength(6);
      } finally { await cleanup(); }
    });

    it('upsertCategory：新增与更新；name 唯一（同名且非自身 → name-conflict 不落库），同 id 改名/重复提交放行', async () => {
      const { store, cleanup } = await make();
      try {
        await store.ensureSeed();
        await store.upsertCategory({ id: 'backend', name: '后端开发（改）' });
        const cats = await store.listCategories();
        expect(cats.find((c) => c.id === 'backend')?.name).toBe('后端开发（改）');
        expect(cats).toHaveLength(5);

        // 同名不同 id → 冲突且不落库
        await store.upsertCategory({ id: 'a', name: '后端开发' });
        await store.upsertCategory({ id: 'b', name: '前端开发' });
        expect(await store.upsertCategory({ id: 'c', name: '后端开发' })).toBe('name-conflict');
        expect((await store.listCategories()).find((c) => c.id === 'c')).toBeUndefined();
        // 同 id 更新自身 name → 放行；同名同 id（幂等重复提交）→ 放行
        expect(await store.upsertCategory({ id: 'a', name: '后端研发' })).toBe('upserted');
        expect(await store.upsertCategory({ id: 'a', name: '后端研发' })).toBe('upserted');
        expect((await store.listCategories()).find((c) => c.id === 'a')?.name).toBe('后端研发');
      } finally { await cleanup(); }
    });

    it('deleteCategory：挂载保护 mounted / 不存在 missing / 正常删除', async () => {
      const { store, cleanup } = await make();
      try {
        await store.ensureSeed();
        await store.upsertSkill(rec());
        expect(await store.deleteCategory('backend')).toBe('mounted');
        expect(await store.deleteCategory('nope')).toBe('missing');
        expect((await store.listCategories()).find((c) => c.id === 'backend')).toBeDefined(); // mounted 不删
        await store.upsertCategory({ id: 'tmp', name: '临时' });
        expect(await store.deleteCategory('tmp')).toBe('deleted');
        expect((await store.listCategories()).find((c) => c.id === 'tmp')).toBeUndefined();
      } finally { await cleanup(); }
    });

    it('upsertSkill + listSkills 过滤（status/categoryId 走窄列）', async () => {
      const { store, cleanup } = await make();
      try {
        await store.ensureSeed();
        const a = rec({ status: 'approved', reviewedAt: Date.now() });
        const b = rec({ categoryId: 'frontend' });
        await store.upsertSkill(a);
        await store.upsertSkill(b);
        expect((await store.listSkills()).length).toBe(2);
        expect((await store.listSkills({ status: 'pending' })).map((s) => s.id)).toEqual([b.id]);
        expect((await store.listSkills({ status: 'approved' })).map((s) => s.id)).toEqual([a.id]);
        expect((await store.listSkills({ categoryId: 'backend' })).map((s) => s.id)).toEqual([a.id]);
        expect((await store.listSkills({ status: 'approved', categoryId: 'frontend' }))).toEqual([]);
        // 同 id 覆盖
        await store.upsertSkill({ ...a, name: '改名' });
        expect((await store.getSkill(a.id))?.name).toBe('改名');
      } finally { await cleanup(); }
    });

    it('reviewSkill：approve / reject 改判 / 重审幂等 / 不存在 null；status 窄列同步', async () => {
      const { store, driver, cleanup } = await make();
      try {
        await store.upsertSkill(rec());
        const s = (await store.listSkills())[0]!;
        expect((await store.reviewSkill(s.id, 'approve'))?.status).toBe('approved');
        expect(await driver.all<{ status: string }>('SELECT status FROM ddw_skills WHERE id = ?', [s.id])
          .then((rows) => rows[0]!.status)).toBe('approved');
        expect((await store.reviewSkill(s.id, 'reject'))?.status).toBe('rejected'); // 允许改判
        expect((await store.reviewSkill(s.id, 'reject'))?.reviewedAt).toBeGreaterThan(0);
        // 改判后窄列与过滤一致
        expect((await store.listSkills({ status: 'rejected' })).map((x) => x.id)).toEqual([s.id]);
        expect(await store.reviewSkill('nope', 'approve')).toBeNull();
      } finally { await cleanup(); }
    });

    it('removeSkill：存在 true / 不存在 false', async () => {
      const { store, cleanup } = await make();
      try {
        await store.ensureSeed();
        const s = rec();
        await store.upsertSkill(s);
        expect(await store.removeSkill(s.id)).toBe(true);
        expect(await store.removeSkill(s.id)).toBe(false);
        expect(await store.getSkill(s.id)).toBeNull();
      } finally { await cleanup(); }
    });

    it('skillsForCategories：仅返回 approved 且命中分类；空入参 → []', async () => {
      const { store, cleanup } = await make();
      try {
        await store.ensureSeed();
        await store.upsertSkill(rec({ status: 'approved' }));
        await store.upsertSkill(rec()); // pending 不算
        await store.upsertSkill(rec({ categoryId: 'frontend', status: 'approved' }));
        const got = await store.skillsForCategories(['backend']);
        expect(got).toHaveLength(1);
        expect(got[0]!.status).toBe('approved');
        expect(got[0]!.categoryId).toBe('backend');
        expect(await store.skillsForCategories([])).toEqual([]);
        expect(await store.skillsForCategories(['nope'])).toEqual([]);
      } finally { await cleanup(); }
    });

    it('store 层形状/路径校验下沉（终审 I1，复用 assertSkillShapeSafe）：upsertSkill 拦坏记录且零落库', async () => {
      const { store, cleanup } = await make();
      try {
        await store.ensureSeed();
        // asset 无 assetFiles
        await expect(store.upsertSkill(rec({ type: 'asset' }))).rejects.toThrow('assetFiles');
        // assetFiles 路径逃逸（distiller 直调 upsertSkill 的攻击面）
        await expect(
          store.upsertSkill(rec({ type: 'asset', assetFiles: [{ path: '../evil.sh', content: 'x' }] })),
        ).rejects.toThrow('..');
        await expect(
          store.upsertSkill(rec({ type: 'asset', assetFiles: [{ path: '/etc/passwd', content: 'x' }] })),
        ).rejects.toThrow('绝对路径');
        await expect(
          store.upsertSkill(rec({ type: 'asset', assetFiles: [{ path: '', content: 'x' }] })),
        ).rejects.toThrow('不能为空');
        // name/content 非空、type 枚举
        await expect(store.upsertSkill(rec({ name: ' ' }))).rejects.toThrow('name');
        await expect(store.upsertSkill(rec({ content: '' }))).rejects.toThrow('content');
        await expect(store.upsertSkill(rec({ type: 'hack' as never }))).rejects.toThrow('type');
        // 坏记录不得落库；合法 asset（相对路径）放行且 assetFiles 往返保留
        expect(await store.listSkills()).toHaveLength(0);
        await store.upsertSkill(rec({
          type: 'asset', assetFiles: [{ path: 'scripts/check.sh', content: 'echo ok' }],
        }));
        const got = (await store.listSkills())[0]!;
        expect(got.assetFiles).toEqual([{ path: 'scripts/check.sh', content: 'echo ok' }]);
      } finally { await cleanup(); }
    });

    it('doc JSON 往返：sourceTaskId / description / createdAt 等字段无损', async () => {
      const { store, cleanup } = await make();
      try {
        await store.ensureSeed();
        const s = rec({ source: 'auto:TASK-1', sourceTaskId: 'TASK-2026-0908-001', description: '沉淀自任务' });
        await store.upsertSkill(s);
        const got = await store.getSkill(s.id);
        expect(got).toMatchObject({
          name: s.name, description: '沉淀自任务', source: 'auto:TASK-1',
          sourceTaskId: 'TASK-2026-0908-001', categoryId: 'backend', createdAt: s.createdAt,
        });
      } finally { await cleanup(); }
    });
  });
}

behaviorSuite('sqlite :memory: 驱动', async () => {
  const driver = new SqliteDriver(':memory:');
  await driver.ensureSchema();
  return { store: new SqlSkillStore(driver), driver, cleanup: () => driver.close() };
});

// mysql 分支（spec 存储企业化）：设 DDW_TEST_MYSQL_URL 才跑（缺 env 整组 skip，离线安全）
d('SqlSkillStore mysql 分支（DDW_TEST_MYSQL_URL）', () => {
  let driver: SqlDriver;

  beforeAll(async () => {
    await resetMysqlTestDb(mysqlUrl!, MYSQL_DB); // DROP/CREATE 测试库（防误指生产库）
    driver = await createMysqlDriver(mysqlTestUrl(mysqlUrl!, MYSQL_DB));
    await driver.ensureSchema();
  });
  afterAll(async () => { await driver?.close(); }); // 库可留，表数据即弃

  afterEach(async () => {
    await driver.exec('DELETE FROM ddw_skills');
    await driver.exec('DELETE FROM ddw_skill_categories');
  });

  behaviorSuite('mysql 驱动', async () => ({
    store: new SqlSkillStore(driver),
    driver,
    cleanup: async () => {
      await driver.exec('DELETE FROM ddw_skills');
      await driver.exec('DELETE FROM ddw_skill_categories');
    },
  }));
});
