import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import {
  EmployeeRuntime, EmployeeSessionStore, ModelGateway, ToolRegistry, EventBus,
  LocalWorkspace, createWorkspaceTools, parseTaskPackage,
  type AgentFactory, type EmployeeProfile, type EmployeeOutcome, type ModelSpec, type TaskPackage,
} from '@ddw/runtime';
import { createHandlers } from '../src/http/handlers.js';
import { FileTaskStore, FileEventStore } from '../src/stores/index.js';
import { createRuntimePipeline, type RuntimePipeline } from '../src/team/pipeline.js';
import { createEmployeeExecutor, type EmployeeExecutor } from '../src/team/executor.js';
import { ManagedRoster } from '../src/team/managed-roster.js';
import { FileEmployeeStore, type EmployeeRecord } from '../src/team/employee-store.js';

/**
 * P9 端到端（一条链走到底）：控制台组装 = startConsoleServer 内部同款
 * （createHandlers + createRuntimePipeline）→ 页面粘 yaml 固化 → 调度器自动分派 →
 * 数字员工执行（真实 EmployeeRuntime + Faux 模型）→ 直播/审计留痕 → hash 链校验 → 名册忙闲复位。
 * （注入式：不监听端口、不起定时器；start() 定时语义已由 pipeline 单测覆盖。）
 */

const YAML = (taskId: string, opts: { role?: string; dependsOn?: string[] } = {}): string => `
taskId: ${taskId}
title: 一体化任务 ${taskId}
${opts.role ? `role: ${opts.role}\n` : ''}${opts.dependsOn ? `dependsOn:\n${opts.dependsOn.map((d) => `  - ${d}`).join('\n')}\n` : ''}repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
tasks: [{ id: T-1, title: t, files: [src/main.js], requirement: r, acceptance: [a] }]
`;

const SCRIPTS: Record<string, { file: string; reply: string }> = {
  'TASK-INT-A': { file: 'src/main.js', reply: '后端开发完成' },
  'TASK-INT-B': { file: 'src/main.js', reply: '联调完成' },
};

let root: string;
let dataDir: string;
let sessionRoot: string;
let tasks: FileTaskStore;
let events: FileEventStore;
let handle: ReturnType<typeof createHandlers>;
let pipeline: RuntimePipeline;

const profiles: EmployeeProfile[] = [
  { id: 'emp-01', name: '小数', role: 'backend', skills: ['backend'] },
  { id: 'emp-02', name: '小智', role: 'frontend', skills: ['frontend'] },
];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-integrated-'));
  dataDir = await mkdtemp(join(tmpdir(), 'ddw-integrated-data-'));
  sessionRoot = await mkdtemp(join(tmpdir(), 'ddw-integrated-sess-'));

  tasks = new FileTaskStore(dataDir);
  events = new FileEventStore(dataDir);
  handle = createHandlers({ tasks, events, employees: profiles });

  // 事件总线 → 事件流落盘（员工事件与调度事件同源，hash 链保序）
  const bus = new EventBus();
  bus.addSink({ write: (e) => events.append(e) });

  const spec: ModelSpec = { name: 'glm', baseUrl: 'http://model-cluster.inner.bank/v1', apiKey: 'k', model: 'glm-5.3-flash' };
  const gateway = new ModelGateway([{ callType: 'code', primary: spec }]);

  const executor: EmployeeExecutor = createEmployeeExecutor({
    workspaceRoot: join(root, 'ws'),
    sessionsRoot: sessionRoot,
    gateway,
    events: bus,
    toolsFor: () => new ToolRegistry(),
    prepareWorkspace: async (dir, task) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, SCRIPTS[task.taskId]!.file), `// ${task.taskId}\n`, 'utf8');
    },
    runtimeFor: ({ task, employee, workspaceDir }) => {
      const ws = new LocalWorkspace(workspaceDir);
      const toolRegistry = new ToolRegistry();
      for (const t of createWorkspaceTools(ws)) toolRegistry.register(t);
      const factory: AgentFactory = (opts) => {
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        const script = SCRIPTS[task.taskId]!;
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall('read_file', { path: script.file })),
          fauxAssistantMessage(fauxText(`${script.reply}（${task.taskId} by ${employee.id}）`)),
        ]);
        return new Agent({
          initialState: { systemPrompt: opts.systemPrompt, model: faux.getModel(), tools: opts.tools },
          streamFn: models.streamSimple.bind(models),
        });
      };
      return new EmployeeRuntime({
        gateway, tools: toolRegistry, interceptors: [], events: bus,
        sessions: new EmployeeSessionStore(join(sessionRoot, employee.id)),
        config: { employeeId: employee.id },
        agentFactory: factory,
      });
    },
  });

  // startConsoleServer 同款装配（runtime 可选配置提供时）
  pipeline = createRuntimePipeline(
    { tasks, events },
    {
      profiles,
      workspaceRoot: join(root, 'ws'),
      sessionsRoot: sessionRoot,
      routes: [{ callType: 'code', primary: spec }],
      executor,
    },
  );
}, 30_000);

afterAll(async () => {
  for (const dir of [root, dataDir, sessionRoot]) await rm(dir, { recursive: true, force: true });
});

/** 生产 tick 语义为只分派不等完成（P10）：轮询等待任务落定 */
async function waitTask(taskId: string, status: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = await tasks.get(taskId);
    if (rec?.status === status) return;
    if (Date.now() > deadline) throw new Error(`等待任务 ${taskId} → ${status} 超时（当前: ${rec?.status}）`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('P9 端到端：一体化运行时一条链', () => {
  it('固化 → 依赖编排自动分派 → 执行 → 直播/审计留痕 → 链校验 → 忙闲复位', async () => {
    // 1. 页面粘 yaml 固化两个任务包（B 依赖 A）
    const resA = await handle({ method: 'POST', path: '/api/tasks', body: YAML('TASK-INT-A', { role: 'backend' }) });
    const resB = await handle({ method: 'POST', path: '/api/tasks', body: YAML('TASK-INT-B', { role: 'frontend', dependsOn: ['TASK-INT-A'] }) });
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    // 发布态（2026-09-06）：创建默认 draft，发布后才可被调度接取
    await handle({ method: 'POST', path: '/api/tasks/TASK-INT-A/publish', body: {} });
    await handle({ method: 'POST', path: '/api/tasks/TASK-INT-B/publish', body: {} });

    // 2. 依赖编排视图：B 等待 A
    const list = (await handle({ method: 'GET', path: '/api/tasks' })).json as { taskId: string; depsState?: string }[];
    expect(list.find((t) => t.taskId === 'TASK-INT-B')!.depsState).toBe('waiting');

    // 3. 调度第一轮：A 分派执行，B 仍等待
    expect(await pipeline.scheduler.tick()).toBe(1);
    await waitTask('TASK-INT-A', 'done');
    const rosterMid = (await handle({ method: 'GET', path: '/api/employees' })).json as { id: string; busy: boolean }[];
    expect(rosterMid.find((e) => e.id === 'emp-01')!.busy).toBe(false); // A 已执行完归还
    expect(list.find((t) => t.taskId === 'TASK-INT-B'));

    // 4. 调度第二轮：B 就绪分派（自动衔接）
    expect(await pipeline.scheduler.tick()).toBe(1);
    await waitTask('TASK-INT-B', 'done');

    // 5. 全程留痕：调度事件 + 员工事件同源可溯
    const allEvents = (await handle({ method: 'GET', path: '/api/events' })).json as {
      type: string; employeeId: string; taskId: string; summary: string;
    }[];
    const dispatches = allEvents.filter((e) => e.type === 'dispatch' && e.summary.startsWith('分派任务'));
    expect(dispatches.map((e) => e.summary)).toEqual([
      '分派任务 TASK-INT-A → emp-01（小数）',
      '分派任务 TASK-INT-B → emp-02（小智）',
    ]);
    const empEvents = allEvents.filter((e) => e.type === 'report');
    expect(empEvents.length).toBeGreaterThanOrEqual(2);
    for (const e of empEvents) expect(e.employeeId).toMatch(/^emp-0[12]$/);

    // 6. 审计台账 v2：任务级聚合（时间线 + 工具统计 + 汇报）
    const audit = (await handle({ method: 'GET', path: '/api/audit/TASK-INT-B' })).json as {
      task: { status: string }; timeline: unknown[]; toolCalls: { name: string; count: number }[]; reply?: string;
    };
    expect(audit.task.status).toBe('done');
    expect(audit.timeline.length).toBeGreaterThan(0);
    expect(audit.toolCalls.some((c) => c.name === 'read_file')).toBe(true);
    expect(audit.reply).toContain('联调完成');

    // 7. hash 链校验：直播/审计同源数据全程未被篡改
    const auditV1 = (await handle({ method: 'GET', path: '/api/audit', query: { integrity: '1' } })).json as {
      integrity: { ok: boolean; total: number };
    };
    expect(auditV1.integrity.ok).toBe(true);
    expect(auditV1.integrity.total).toBe(allEvents.length);

    // 8. 名册忙闲复位：两名员工全部空闲
    const rosterEnd = (await handle({ method: 'GET', path: '/api/employees' })).json as { id: string; busy: boolean; runningTasks: string[] }[];
    expect(rosterEnd.map((e) => e.busy)).toEqual([false, false]);
    expect(rosterEnd.every((e) => e.runningTasks.length === 0)).toBe(true);

    // 9. 任务池终态
    const final = (await handle({ method: 'GET', path: '/api/tasks' })).json as { taskId: string; status: string }[];
    expect(final.map((t) => t.status)).toEqual(['done', 'done']);
  });
});

/**
 * 遗留收尾 T1（2026-09-08）：ManagedRoster 岗位匹配调度链 e2e。
 * 管理台装配层（server.ts）实际接线是 ManagedRoster（员工档案为事实源）+ canDispatch 谓词
 * + onBeforeTick 每 tick 刷新；此前链路级 e2e 只覆盖 runtime EmployeeRoster 回退名册，
 * 多岗匹配（pkg.role ∈ emp.roles，2026-09-07 岗位即分类）与失配留池语义没有被端到端锁死。
 * 装配 = startConsoleServer 同款 createRuntimePipeline 接线 + faux executor（分派语义观测点）。
 */
describe('ManagedRoster 调度链 e2e：员工档案多岗匹配分派 + 失配留池', () => {
  let mrRoot: string;
  let mrData: string;
  let mrSess: string;
  let mrTasks: FileTaskStore;
  let mrEvents: FileEventStore;
  let mrPipeline: RuntimePipeline;

  /** 执行留痕：`taskId:employeeId`（断言分派对象） */
  const ran: string[] = [];
  /** 闸门任务集合：执行到 executor 即挂起，release 前不落终态（模拟长任务占岗） */
  const gated = new Set<string>();
  const gateResolvers = new Map<string, () => void>();

  const executor: EmployeeExecutor = async ({ task, employee }) => {
    ran.push(`${task.taskId}:${employee.id}`);
    if (gated.has(task.taskId)) {
      await new Promise<void>((r) => gateResolvers.set(task.taskId, r));
    }
    return { status: 'done', reply: `ok:${task.taskId}`, turns: 1 };
  };
  const releaseGate = (taskId: string): void => {
    gated.delete(taskId);
    gateResolvers.get(taskId)?.();
    gateResolvers.delete(taskId);
  };

  const mrWait = async (taskId: string, status: string, timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rec = await mrTasks.get(taskId);
      if (rec?.status === status) return;
      if (Date.now() > deadline) throw new Error(`等待任务 ${taskId} → ${status} 超时（当前: ${rec?.status}）`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const empRecord = (id: string, name: string, roles: string[]): EmployeeRecord => ({
    // skills 为退役字段随意值：岗位匹配只看 roles（pkg.role ∈ emp.roles）
    id, name, roles, skills: [], capabilities: [], enabled: true, createdAt: 1,
  });

  beforeAll(async () => {
    mrRoot = await mkdtemp(join(tmpdir(), 'ddw-mroster-e2e-'));
    mrData = await mkdtemp(join(tmpdir(), 'ddw-mroster-e2e-data-'));
    mrSess = await mkdtemp(join(tmpdir(), 'ddw-mroster-e2e-sess-'));

    mrTasks = new FileTaskStore(mrData);
    mrEvents = new FileEventStore(mrData);

    // 员工档案：一名多岗员工 + 一名单岗员工（EmployeeStore 为调度名册唯一事实源）
    const employeeStore = new FileEmployeeStore(join(mrData, 'employees.json'));
    await employeeStore.upsert(empRecord('emp-full', '多岗员工', ['后端开发', '前端开发']));
    await employeeStore.upsert(empRecord('emp-be', '单岗后端', ['后端开发']));
    const managedRoster = new ManagedRoster(employeeStore);
    await managedRoster.refresh();

    // startConsoleServer 同款装配（server.ts 100~157 行）：roster/canDispatch/onBeforeTick 三件套接线
    mrPipeline = createRuntimePipeline(
      { tasks: mrTasks, events: mrEvents },
      {
        workspaceRoot: join(mrRoot, 'ws'),
        sessionsRoot: mrSess,
        routes: [], // faux executor 不触达 gateway
        roster: managedRoster,
        canDispatch: (task, employee) => managedRoster.canDispatch(task, employee),
        onBeforeTick: () => managedRoster.refresh(),
        executor,
      },
    );
  }, 30_000);

  afterAll(async () => {
    for (const dir of [mrRoot, mrData, mrSess]) await rm(dir, { recursive: true, force: true });
  });

  it('岗位命中多岗员工按 roles 分派；岗位无匹配/员工全忙 → 任务留池 waiting，释放后自动接单', async () => {
    // —— ① 多岗命中：'前端开发' 只有 emp-full（roles 含此岗）能接，单岗后端不得命中 ——
    await mrTasks.add(parseTaskPackage(YAML('TASK-MR-FE', { role: '前端开发' })));
    expect(await mrPipeline.scheduler.tick()).toBe(1);
    await mrWait('TASK-MR-FE', 'done');
    expect((await mrTasks.get('TASK-MR-FE'))!.claimedBy).toBe('emp-full');
    expect(ran).toContain('TASK-MR-FE:emp-full');

    // —— ② 失配留池：'测试工程师' 无员工持有 → 不分派，任务留在池内 + waiting 留痕 ——
    await mrTasks.add(parseTaskPackage(YAML('TASK-MR-ORPHAN', { role: '测试工程师' })));
    expect(await mrPipeline.scheduler.tick()).toBe(0);
    expect((await mrTasks.get('TASK-MR-ORPHAN'))!.status).toBe('pending'); // 留池（waiting/排队语义）
    const orphanNotes = (await mrEvents.list({ type: 'dispatch' }))
      .filter((e) => e.taskId === 'TASK-MR-ORPHAN').map((e) => e.summary);
    expect(orphanNotes).toContain('waiting: 无空闲员工匹配岗位');

    // —— ③ 忙时排队：emp-full 被前端任务占岗 → 第二个前端任务留池；单岗员工接后端任务 ——
    gated.add('TASK-MR-FE2');
    await mrTasks.add(parseTaskPackage(YAML('TASK-MR-FE2', { role: '前端开发' })));
    expect(await mrPipeline.scheduler.tick()).toBe(1);
    await mrWait('TASK-MR-FE2', 'running'); // 闸门挂起中，emp-full 占岗
    expect(ran).toContain('TASK-MR-FE2:emp-full');

    await mrTasks.add(parseTaskPackage(YAML('TASK-MR-FE3', { role: '前端开发' })));
    expect(await mrPipeline.scheduler.tick()).toBe(0); // emp-full 忙、emp-be 无此岗 → 留池
    expect((await mrTasks.get('TASK-MR-FE3'))!.status).toBe('pending');

    await mrTasks.add(parseTaskPackage(YAML('TASK-MR-BE', { role: '后端开发' })));
    expect(await mrPipeline.scheduler.tick()).toBe(1);
    await mrWait('TASK-MR-BE', 'done');
    // emp-full 被占岗自动跳过（员工级串行化），后端任务落到单岗员工
    expect((await mrTasks.get('TASK-MR-BE'))!.claimedBy).toBe('emp-be');
    expect(ran).toContain('TASK-MR-BE:emp-be');

    // —— ④ 释放后再接：FE2 完成归岗 → 留池的 FE3 下轮 tick 自动分派 emp-full ——
    releaseGate('TASK-MR-FE2');
    await mrWait('TASK-MR-FE2', 'done');
    expect(await mrPipeline.scheduler.tick()).toBe(1);
    await mrWait('TASK-MR-FE3', 'done');
    expect((await mrTasks.get('TASK-MR-FE3'))!.claimedBy).toBe('emp-full');

    // —— 全程分派留痕按序可溯（失配 waiting 留痕不计入分派清单）——
    const dispatchSummaries = (await mrEvents.list({ type: 'dispatch' }))
      .map((e) => e.summary).filter((s) => s.startsWith('分派任务'));
    expect(dispatchSummaries).toEqual([
      '分派任务 TASK-MR-FE → emp-full（多岗员工）',
      '分派任务 TASK-MR-FE2 → emp-full（多岗员工）',
      '分派任务 TASK-MR-BE → emp-be（单岗后端）',
      '分派任务 TASK-MR-FE3 → emp-full（多岗员工）',
    ]);
    // 失配任务全程无人接单
    expect(ran).not.toContain('TASK-MR-ORPHAN:emp-full');
    expect(ran).not.toContain('TASK-MR-ORPHAN:emp-be');
  }, 30_000);
});
