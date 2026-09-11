import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelSpec } from '@ddw/runtime';
import { startConsoleServer } from '../src/http/server.js';
import type { ConsoleRuntimeOptions } from '../src/team/pipeline.js';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import { SqlEventStore } from '../src/stores/sql/sql-event-store.js';
import { SqlEmployeeStore } from '../src/stores/sql/sql-employee-store.js';
import { SqlSkillStore } from '../src/stores/sql/sql-skill-store.js';
import type { EmployeeRecord } from '../src/team/employee-store.js';
import type { SkillCategory, SkillRecord } from '../src/team/skill-store.js';

// 终审 C1 装配层测试（2026-09-06）：startConsoleServer 必须把 skillsFor 接进 createRuntimePipeline 的 opts——
// 此前生产装配层漏传，inproc/fork 两链路 Skill 注入恒缺省（功能性死代码）。
// 双打桩：node:createServer 不真实 listen；pipeline 工厂替换为捕获 opts 的桩（不建执行器/不起定时器）。
const httpMock = vi.hoisted(() => {
  const state: { handler?: unknown } = {};
  return state;
});
const pipelineMock = vi.hoisted(() => {
  const state: { opts?: ConsoleRuntimeOptions } = {};
  return state;
});

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  const fakeServer = {
    listen: () => fakeServer,
    on: () => fakeServer,
    close: () => fakeServer,
  };
  return {
    ...actual,
    createServer: (handler: unknown) => {
      httpMock.handler = handler;
      return fakeServer;
    },
  } as unknown as typeof actual;
});

vi.mock('../src/team/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/team/pipeline.js')>();
  return {
    ...actual,
    createRuntimePipeline: (_deps: unknown, opts: ConsoleRuntimeOptions) => {
      pipelineMock.opts = opts;
      return { scheduler: {}, reviewQueue: {}, start: () => {}, stop: () => {} } as never;
    },
  };
});

const spec: ModelSpec = { name: 'glm-test', baseUrl: 'http://model.local/v1', apiKey: 'k', model: 'glm-test' };

/**
 * 预置员工档案与 Skill 库（2026-09-07 岗位即分类语义；存储企业化 Task 7 起直接种库）：
 * - emp-sk role=「后端开发」（分类 name，含 approved + pending 各一 skill）；
 * - emp-idle role=「闲职」（分类存在但无 skill）；
 * - emp-ghost role=「自由岗」（无对应分类）。
 * 说明：档案入库后无法在 start 后改 role 复用同一员工，
 * 故用多个 role 各异的员工等价覆盖「岗位变化 → 注入变化」语义。
 * 种库走装配同款 SqliteDriver（`<root>/ddw.sqlite`）：server 启动后 ensureSeed 见表非空即跳过，种子不被覆盖。
 */
async function seedStores(root: string): Promise<void> {
  const driver = new SqliteDriver(join(root, 'ddw.sqlite'));
  await driver.ensureSchema();
  const employees: EmployeeRecord[] = [
    { id: 'emp-sk', name: '小技', roles: ['后端开发'], capabilities: [], enabled: true, createdAt: 1 },
    { id: 'emp-idle', name: '小闲', roles: ['闲职'], capabilities: [], enabled: true, createdAt: 1 },
    { id: 'emp-ghost', name: '小游', roles: ['自由岗'], capabilities: [], enabled: true, createdAt: 1 },
    // 多岗位员工（Task 3）：roles 数组入库（normalizeStored 读出即 roles），覆盖注入过滤语义
    { id: 'emp-multi', name: '小多', roles: ['后端开发', '前端开发'], capabilities: [], enabled: true, createdAt: 1 },
  ];
  const employeeStore = new SqlEmployeeStore(driver);
  for (const rec of employees) await employeeStore.upsert(rec);
  const categories: SkillCategory[] = [
    { id: 'backend', name: '后端开发' }, { id: 'idle', name: '闲职' }, { id: 'fe', name: '前端开发' },
  ];
  const skills: SkillRecord[] = [
    {
      id: 'skill-ok1', categoryId: 'backend', name: '异常码规范', description: '', type: 'knowledge',
      content: '异常码以 E 开头', status: 'approved', source: 'manual', createdAt: 1,
    },
    {
      id: 'skill-pd1', categoryId: 'backend', name: '未批准规范', description: '', type: 'knowledge',
      content: 'pending 不注入', status: 'pending', source: 'manual', createdAt: 1,
    },
    {
      id: 'skill-fe1', categoryId: 'fe', name: '组件规范', description: '', type: 'knowledge',
      content: '组件一律函数式', status: 'approved', source: 'manual', createdAt: 1,
    },
  ];
  const skillStore = new SqlSkillStore(driver);
  for (const cat of categories) await skillStore.upsertCategory(cat);
  for (const rec of skills) await skillStore.upsertSkill(rec);
  await driver.close();
}

describe('startConsoleServer 装配接线：skillsFor 注入 pipeline（终审 C1，2026-09-06）', () => {
  it('runtime 装配时 opts.skillsFor 为函数，且按员工岗位（role=分类 name）实时取 approved skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-server-skills-'));
    try {
      await seedStores(root);
      await startConsoleServer({
        dataDir: root,
        runtime: {
          workspaceRoot: join(root, 'ws'),
          sessionsRoot: join(root, 'sessions'),
          routes: [{ callType: 'code', primary: spec }],
        },
      });

      const opts = pipelineMock.opts;
      expect(opts).toBeDefined();
      // 断言目标：装配层真的把 skillsFor 接进去了（漏传 = undefined）
      expect(opts!.skillsFor).toBeTypeOf('function');

      const fn = opts!.skillsFor!;
      // 命中：员工岗位=「后端开发」→ 返回该分类 approved skill（pending 不返回）
      const got = await fn('emp-sk');
      expect(got.map((s) => s.id)).toEqual(['skill-ok1']);
      expect(got[0]!.status).toBe('approved');
      // 未注册员工 → 空数组（不炸）
      expect(await fn('emp-none')).toEqual([]);
    } finally {
      await cleanupDataDir(root);
    }
  });

  it('skillsFor 按岗位注入（2026-09-07 岗位即分类）：role=分类 name → 该分类 approved skill；无 skill/无对应分类岗位 → 空清单不抛错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-server-role-'));
    try {
      await seedStores(root);
      await startConsoleServer({
        dataDir: root,
        runtime: {
          workspaceRoot: join(root, 'ws'),
          sessionsRoot: join(root, 'sessions'),
          routes: [{ callType: 'code', primary: spec }],
        },
      });

      const fn = pipelineMock.opts!.skillsFor!;
      expect(fn).toBeTypeOf('function');
      // role=「后端开发」→ 注入 backend 分类 approved skill（pending 不注入）
      expect((await fn('emp-sk')).map((s) => s.id)).toEqual(['skill-ok1']);
      // role=「闲职」：分类存在但无 skill → 空清单不抛错
      expect(await fn('emp-idle')).toEqual([]);
      // role=「自由岗」：无对应分类（被删/未建）→ 空清单不抛错
      expect(await fn('emp-ghost')).toEqual([]);
    } finally {
      await cleanupDataDir(root);
    }
  });

  it('skillsFor 按任务岗位过滤（Task 3 多岗位）：taskRole 命中员工集合 → 单岗精准注入；taskRole 缺省 → 全岗位并集；taskRole 不在集合 → 并集兜底', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-server-role-filter-'));
    try {
      await seedStores(root);
      await startConsoleServer({
        dataDir: root,
        runtime: {
          workspaceRoot: join(root, 'ws'),
          sessionsRoot: join(root, 'sessions'),
          routes: [{ callType: 'code', primary: spec }],
        },
      });

      const fn = pipelineMock.opts!.skillsFor!;
      expect(fn).toBeTypeOf('function');
      // emp-multi roles=[后端开发, 前端开发]，两岗各有一条 approved skill
      // 命中：taskRole=后端开发 ∈ 集合 → 只注入 backend 分类（精准，前端 skill 不掺入）
      expect((await fn('emp-multi', '后端开发')).map((s) => s.id)).toEqual(['skill-ok1']);
      // 缺省：不传 taskRole → 全岗位并集（backend + fe 两条 approved；排序无关断言）
      expect((await fn('emp-multi')).map((s) => s.id).sort()).toEqual(['skill-fe1', 'skill-ok1']);
      // 兜底：taskRole=测试 不在员工岗位集合 → 并集兜底（防裸奔），仍两条
      expect((await fn('emp-multi', '测试')).map((s) => s.id).sort()).toEqual(['skill-fe1', 'skill-ok1']);
    } finally {
      await cleanupDataDir(root);
    }
  });

  it('skillsFor 对 taskRole 做 trim（Task 1 trim 收口）：带空格的任务岗位仍走精准分支，不落入并集兜底', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-server-role-trim-'));
    try {
      await seedStores(root);
      await startConsoleServer({
        dataDir: root,
        runtime: {
          workspaceRoot: join(root, 'ws'),
          sessionsRoot: join(root, 'sessions'),
          routes: [{ callType: 'code', primary: spec }],
        },
      });

      const fn = pipelineMock.opts!.skillsFor!;
      expect(fn).toBeTypeOf('function');
      // executor 传 task.role 原值（可能带首尾空格）：' 后端开发 ' trim 后 ∈ 员工岗位集合
      // → 精准分支，只注入 backend 分类 approved skill（前端 skill 不掺入）
      expect((await fn('emp-multi', ' 后端开发 ')).map((s) => s.id)).toEqual(['skill-ok1']);
      // 空白岗位 trim 后为空串 → falsy → 并集兜底（与「缺省 taskRole」同路径）
      expect((await fn('emp-multi', '   ')).map((s) => s.id).sort()).toEqual(['skill-fe1', 'skill-ok1']);
    } finally {
      await cleanupDataDir(root);
    }
  });

  it('onTaskComplete 蒸馏钩子真实执行（终审补装）：调用后返回 Promise 且事件落盘留痕', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-server-distill-'));
    try {
      await seedStores(root);
      await startConsoleServer({
        dataDir: root,
        runtime: {
          workspaceRoot: join(root, 'ws'),
          sessionsRoot: join(root, 'sessions'),
          // 含 chat 路由才注入 gateway/蒸馏钩子；地址指向未监听端口（连接立即拒绝，不触网）
          routes: [
            { callType: 'code', primary: spec },
            { callType: 'chat', primary: { ...spec, baseUrl: 'http://127.0.0.1:1/v1' } },
          ],
        },
      });

      const opts = pipelineMock.opts;
      expect(opts?.onTaskComplete).toBeTypeOf('function');
      // 终审修复回归：此前两段工厂被当一次调用，返回未执行的闭包——生产蒸馏从未跑起。
      // 语义对齐调度器（Promise.resolve(onTaskComplete(...))）：返回 void 即可，不得同步抛错
      expect(() =>
        opts!.onTaskComplete!(
          { taskId: 'T-ASM', title: '装配蒸馏', repo: { url: 'http://x/a.git', branch: 'main' }, tasks: [] } as never,
          { id: 'emp-sk', name: '小技', role: 'backend', skills: [] } as never,
        ),
      ).not.toThrow();
      // 蒸馏链路真实跑过：不可达模型 → 「Skill 沉淀失败」留痕事件入库（ddw_events）。
      // 独立第二条 sqlite 连接轮询（WAL 下并发读安全），不动装配内部 store
      const pollDriver = new SqliteDriver(join(root, 'ddw.sqlite'));
      try {
        const pollEvents = new SqlEventStore(pollDriver, { headsPath: null });
        let found = '';
        for (let i = 0; i < 1000 && !found; i++) {
          const evs = (await pollEvents.list()) as { summary?: string }[];
          found = evs.map((e) => e.summary ?? '').find((s) => s.includes('Skill 沉淀')) ?? '';
          if (!found) await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        expect(found).toContain('Skill 沉淀');
      } finally {
        await pollDriver.close();
      }
    } finally {
      await cleanupDataDir(root);
    }
  });
});

/** 数据目录清理：装配已 await（ensureSchema 完成），直接重试 rm（卸链后的 seed 写入落在已 unlink 的 inode） */
async function cleanupDataDir(root: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try {
      await rm(root, { recursive: true, force: true });
      break;
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
