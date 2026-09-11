import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmployeeRoster, parseTaskPackage } from '@ddw/runtime';
import type { EmployeeProfile } from '@ddw/runtime';
import { FileTaskStore, FileEventStore } from '../src/stores/index.js';
import type { TaskStore, EventStore } from '../src/stores/index.js';
import { TeamScheduler } from '../src/team/scheduler.js';
import { createRuntimePipeline } from '../src/team/pipeline.js';
import { CAPABILITY_PRESETS } from '../src/team/capabilities.js';

/**
 * P13-T4 多进程横向扩展验收：
 * ① 双调度实例（各自 roster / 各自 scheduler）共享同一 TaskStore 并发 tick——
 *    claim 原子抢单兜底，每任务恰好分派一次（多实例调度安全证明）。
 * ② fork 模式一条链 e2e：固化 → 分派 → 独立 worker 子进程执行 → 事件回流主库 →
 *    审计 hash 链完整（直播数据源即事件流，SSE 通道已在 sse.test.ts 覆盖）。
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAUX_AGENT = join(FIXTURES, 'faux-agent.mjs');
const FAUX_PLAN_AGENT = join(FIXTURES, 'faux-agent-plan.mjs');

const YAML = (taskId: string, dependsOn: string[] = []): string => `
taskId: ${taskId}
title: fork 链任务 ${taskId}
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
${dependsOn.length ? `dependsOn: [${dependsOn.join(', ')}]` : ''}
tasks: [{ id: T-1, title: t, files: [src/main.js], requirement: r, acceptance: [a] }]
`;

// 计划任务包（plan 与 tasks 互斥）：第二项带 verify（执行器亲自跑的客观门禁）
const PLAN_YAML = `
taskId: PLAN-FORK
title: fork 计划任务
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
plan:
  - id: T-1
    title: 开发
    detail: 写代码
  - id: T-2
    kind: test
    title: 测试
    detail: 跑测试
    verify: exit 0
`;

const emp = (id: string): EmployeeProfile => ({ id, name: `员工${id}`, role: 'backend', skills: ['backend'], supervision: { level: 'assisted' } });

let root: string;
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function waitUntil(pred: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`等待 ${what} 超时`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('P13 fork 模式验收', () => {
  it('双调度实例并发 tick：claim 原子兜底，每任务恰好分派一次', async () => {
    root = await mkdtemp(join(tmpdir(), 'ddw-fork-e2e-'));
    const tasks: TaskStore = new FileTaskStore(join(root, 'dual-data'));
    const events: EventStore = new FileEventStore(join(root, 'dual-data'));
    for (const id of ['DUAL-A', 'DUAL-B', 'DUAL-C', 'DUAL-D']) {
      await tasks.add(parseTaskPackage(YAML(id)));
    }

    // 两个"进程"各自组装调度器（各自 roster/executor），仅共享 TaskStore/EventStore
    const ran: string[] = [];
    const makeScheduler = () => new TeamScheduler({
      tasks, events,
      roster: new EmployeeRoster([emp('emp-01'), emp('emp-02')]),
      executor: async ({ task }) => {
        ran.push(task.taskId);
        return { status: 'done', reply: 'ok', turns: 1 };
      },
    });
    const s1 = makeScheduler();
    const s2 = makeScheduler();

    const [n1, n2] = await Promise.all([s1.tick(), s2.tick()]);
    expect(n1 + n2).toBe(4); // 四个任务全部被某一实例分派
    expect(ran.sort()).toEqual(['DUAL-A', 'DUAL-B', 'DUAL-C', 'DUAL-D']); // 每任务恰好执行一次
    expect((await tasks.get('DUAL-A'))!.status).toBe('done');

    // 分派留痕每任务一条（无重复分派）
    const dispatches = (await events.list({ type: 'dispatch' })).filter((e) => e.summary.startsWith('分派任务'));
    expect(dispatches).toHaveLength(4);
  });

  it('fork 模式一条链：固化 → 依赖序分派 → worker 子进程执行 → 事件回流 → integrity ok', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'ddw-fork-chain-'));
    const tasks: TaskStore = new FileTaskStore(join(root, 'chain-data'));
    const events: EventStore = new FileEventStore(join(root, 'chain-data'));
    const pipeline = createRuntimePipeline(
      { tasks, events },
      {
        profiles: [emp('emp-01')],
        workspaceRoot: join(root, 'ws'),
        sessionsRoot: join(root, 'sessions'),
        routes: [{ callType: 'code', primary: { name: 'glm', baseUrl: 'http://model-cluster.inner.bank/v1', apiKey: 'k', model: 'glm-5.3-flash' } }],
        execMode: 'fork',
        agentModulePath: FAUX_AGENT,
      },
    );

    // 固化入库：上游 A → 下游 B（dependsOn 链）
    await tasks.add(parseTaskPackage(YAML('CHAIN-A')));
    await tasks.add(parseTaskPackage(YAML('CHAIN-B', ['CHAIN-A'])));

    // 第一轮：只有 A 就绪可分派；B waiting
    expect(await pipeline.scheduler.tick()).toBe(1);
    await waitUntil(async () => (await tasks.get('CHAIN-A'))?.status === 'done', 'CHAIN-A done（worker 子进程）');

    // 第二轮：A 完成解锁 B，同样 fork 执行
    expect(await pipeline.scheduler.tick()).toBe(1);
    await waitUntil(async () => (await tasks.get('CHAIN-B'))?.status === 'done', 'CHAIN-B done（worker 子进程）');

    // 事件全在主库（直播/审计数据源）：调度留痕 + 员工执行留痕
    const all = await events.list();
    expect(all.filter((e) => e.type === 'dispatch').map((e) => e.summary)).toEqual(expect.arrayContaining([
      expect.stringContaining('分派任务 CHAIN-A → emp-01'),
      expect.stringContaining('任务 CHAIN-A 完成'),
      expect.stringContaining('分派任务 CHAIN-B → emp-01'),
      expect.stringContaining('任务 CHAIN-B 完成'),
    ]));
    for (const tid of ['CHAIN-A', 'CHAIN-B']) {
      const own = all.filter((e) => e.taskId === tid && e.employeeId === 'emp-01');
      expect(own.some((e) => e.type === 'report')).toBe(true);
      expect(own.some((e) => e.type === 'task_check')).toBe(true);
    }
    // 审计 hash 链完整（跨进程事件回流不破链）
    expect(await events.verifyIntegrity?.()).toMatchObject({ ok: true });
  });

  it('fork 模式 plan 任务：worker plan 分流逐项执行 → planProgress 经 IPC 落库，两项 done', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'ddw-fork-plan-'));
    const tasks: TaskStore = new FileTaskStore(join(root, 'plan-data'));
    const events: EventStore = new FileEventStore(join(root, 'plan-data'));
    const pipeline = createRuntimePipeline(
      { tasks, events },
      {
        profiles: [emp('emp-01')],
        workspaceRoot: join(root, 'ws'),
        sessionsRoot: join(root, 'sessions'),
        routes: [{ callType: 'code', primary: { name: 'glm', baseUrl: 'http://model-cluster.inner.bank/v1', apiKey: 'k', model: 'glm-5.3-flash' } }],
        execMode: 'fork',
        agentModulePath: FAUX_PLAN_AGENT,
        capabilities: async () => CAPABILITY_PRESETS.map((d) => ({ ...d })),
      },
    );

    await tasks.add(parseTaskPackage(PLAN_YAML));
    expect(await pipeline.scheduler.tick()).toBe(1);
    await waitUntil(async () => (await tasks.get('PLAN-FORK'))?.status === 'done', 'PLAN-FORK done（worker plan 分流）');

    // 进度经 IPC 落库：两项 done、无停点
    const rec = await tasks.get('PLAN-FORK');
    expect(rec?.planProgress).toEqual([
      { itemId: 'T-1', kind: 'dev', title: '开发', status: 'done' },
      { itemId: 'T-2', kind: 'test', title: '测试', status: 'done' },
    ]);
    expect(rec?.failedItemId).toBeUndefined();

    // 事件全在主库：计划项开始/完成留痕 + task_check 申报（第二项 verify 由 worker 真跑 exit 0）
    const all = await events.list();
    const own = all.filter((e) => e.taskId === 'PLAN-FORK' && e.employeeId === 'emp-01');
    expect(own.some((e) => e.type === 'task_check')).toBe(true);
    expect(own.filter((e) => (e.payload as { plan?: { phase?: string } } | undefined)?.plan?.phase === 'done')).toHaveLength(2);
    expect(await events.verifyIntegrity?.()).toMatchObject({ ok: true });
  });
});
