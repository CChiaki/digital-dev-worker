import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMysqlDriver } from '../src/stores/sql/mysql-driver.js';
import type { SqlDriver } from '../src/stores/sql/driver.js';
import {
  SqlTaskStore, SqlEventStore, SqlEmployeeStore, SqlSkillStore,
} from '../src/stores/index.js';
import type { TaskPackage } from '@ddw/runtime';
import type { EmployeeRecord } from '../src/team/employee-store.js';
import type { SkillCategory, SkillRecord } from '../src/team/skill-store.js';
import { mysqlTestUrl, resetMysqlTestDb } from './helpers/mysql.js';

/**
 * mysql 冒烟 e2e（存储企业化 Task 7，env 开关）：注入 DDW_TEST_MYSQL_URL 才真跑（缺 env 整组 skip，离线安全）。
 * 独立测试库 ddw_test_smoke（与 T5/T6 的 ddw_test_employees/_skills 等隔离，vitest 并行互不踩踏）。
 * 最小代价链路：store 层直接组装（不必经 HTTP/executor——装配语义已由 server-assembly 双打桩覆盖），
 * 验证 mysql 驱动承载 全业务链：
 *   任务 创建(draft) → publish → claim → markRunning → finish → 事件 append → verifyIntegrity（hash 链 + 无快照）；
 *   员工 upsert → get → list → setEnabled → 重新启用；
 *   Skill 分类 upsert → skill 入库 → 人工终审 → skillsForCategories → 删除清理。
 */

const mysqlUrl = process.env.DDW_TEST_MYSQL_URL;
const dmysql = mysqlUrl ? describe : describe.skip;

const MYSQL_DB = 'ddw_test_smoke'; // 独立后缀：与 driver/employee/skill 等测试库隔离，并行不互踩

const PKG: TaskPackage = {
  taskId: 'T-SMOKE-1',
  title: 'mysql 冒烟任务',
  repo: { url: 'http://gitlab.inner.bank/x.git', branch: 'main' },
  tasks: [{ id: 'T-1', title: '冒烟项', files: ['src/main.js'], requirement: 'r', acceptance: ['a'] }],
};

const EMP: EmployeeRecord = {
  id: 'emp-smoke', name: '小烟', roles: ['后端开发'], capabilities: [], enabled: true, createdAt: 1,
};

dmysql('mysql smoke e2e（DDW_TEST_MYSQL_URL，库 ddw_test_smoke）', () => {
  let driver: SqlDriver;

  beforeAll(async () => {
    await resetMysqlTestDb(mysqlUrl!, MYSQL_DB); // DROP/CREATE 测试库（库名强制改写，防误指生产库）
    driver = await createMysqlDriver(mysqlTestUrl(mysqlUrl!, MYSQL_DB));
    await driver.ensureSchema();
  });
  afterAll(async () => {
    await driver.close(); // 库可留，表数据即弃
  });

  it('任务链：draft 创建 → publish → claim → finish，全链状态迁移正确', async () => {
    const tasks = new SqlTaskStore(driver);
    // 创建即草稿（2026-09-06 发布态语义）
    const draft = await tasks.add(PKG, { draft: true });
    expect(draft.status).toBe('draft');
    // 发布：draft → pending
    expect((await tasks.publish(PKG.taskId)).status).toBe('pending');
    // 接单：pending → claimed
    const claimed = await tasks.claim(PKG.taskId, EMP.id);
    expect(claimed.status).toBe('claimed');
    expect(claimed.claimedBy).toBe(EMP.id);
    expect((await tasks.markRunning(PKG.taskId)).status).toBe('running');
    // 回写结果：running → done
    const done = await tasks.finish(PKG.taskId, { status: 'done', reply: '冒烟完成', turns: 1 }, true);
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ status: 'done', reply: '冒烟完成' });
    expect((await tasks.get(PKG.taskId))?.status).toBe('done');
  });

  it('事件审计：append 成链 → verifyIntegrity 通过（hash 链全量重算）', async () => {
    const events = new SqlEventStore(driver, { headsPath: null }); // 冒烟不落快照文件（无 dataDir 语义）
    await events.append({ id: 'ev-smoke-1', ts: 1000, taskId: PKG.taskId, employeeId: EMP.id, type: 'thinking', summary: '开始冒烟' });
    await events.append({ id: 'ev-smoke-2', ts: 2000, taskId: PKG.taskId, employeeId: EMP.id, type: 'tool_call', summary: 'gitlab_commit_files' });
    await events.append({ id: 'ev-smoke-3', ts: 3000, taskId: PKG.taskId, employeeId: EMP.id, type: 'report', summary: '冒烟完成' });
    const listed = await events.list({ taskId: PKG.taskId });
    expect(listed.map((e) => e.id)).toEqual(['ev-smoke-1', 'ev-smoke-2', 'ev-smoke-3']);
    const report = await events.verifyIntegrity();
    expect(report.ok).toBe(true);
    expect(report.total).toBe(3);
  });

  it('员工 CRUD：upsert → get/list → setEnabled 停用 → 重新启用', async () => {
    const employees = new SqlEmployeeStore(driver);
    await employees.upsert(EMP);
    expect(await employees.get(EMP.id)).toMatchObject({ id: EMP.id, roles: ['后端开发'], enabled: true });
    expect((await employees.list()).some((r) => r.id === EMP.id)).toBe(true);
    expect((await employees.setEnabled(EMP.id, false))?.enabled).toBe(false);
    expect((await employees.get(EMP.id))?.enabled).toBe(false);
    expect((await employees.setEnabled(EMP.id, true))?.enabled).toBe(true);
  });

  it('Skill CRUD：分类 upsert → skill 入库 → 终审 approved → skillsForCategories → 清理', async () => {
    const skills = new SqlSkillStore(driver);
    const cat: SkillCategory = { id: 'cat-smoke', name: '冒烟岗' };
    expect(await skills.upsertCategory(cat)).toBe('upserted');
    // 同名不同 id → name 冲突不落库（岗位 name 业务键）
    expect(await skills.upsertCategory({ ...cat, id: 'cat-smoke-2' })).toBe('name-conflict');

    const rec: SkillRecord = {
      id: 'skill-smoke1', categoryId: cat.id, name: '冒烟规范', description: 'smoke', type: 'knowledge',
      content: '冒烟用 skill', status: 'pending', source: 'manual', createdAt: 1,
    };
    await skills.upsertSkill(rec);
    expect((await skills.reviewSkill(rec.id, 'approve'))?.status).toBe('approved');
    expect((await skills.skillsForCategories([cat.id])).map((s) => s.id)).toEqual([rec.id]);
    // pending 不注入
    await skills.upsertSkill({ ...rec, id: 'skill-smoke2', status: 'pending' });
    expect((await skills.skillsForCategories([cat.id])).map((s) => s.id)).toEqual([rec.id]);
    // 清理：先删 skill 再删分类（mounted 防护）
    expect(await skills.removeSkill('skill-smoke1')).toBe(true);
    expect(await skills.removeSkill('skill-smoke2')).toBe(true);
    expect(await skills.deleteCategory(cat.id)).toBe('deleted');
  });
});
