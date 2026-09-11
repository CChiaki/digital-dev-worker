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
  type AgentFactory, type EmployeeProfile, type ModelSpec,
} from '@ddw/runtime';
import { createHandlers } from '../src/http/handlers.js';
import { FileTaskStore, FileEventStore } from '../src/stores/index.js';
import { createRuntimePipeline, type RuntimePipeline } from '../src/team/pipeline.js';
import { createEmployeeExecutor, type EmployeeExecutor } from '../src/team/executor.js';
import { CheckReviewQueue, gateForTask } from '../src/team/review-gate.js';

/**
 * P10 端到端（人工盯梢闭环一条链）：shadow 员工 task_check 申报 → 阻塞 →
 * 控制台待审可见（GET /api/checks）→ 驳回（带意见）→ 员工收到工具错误修正后重新申报 →
 * 放行 → 任务 done；全程 task_check/intervention 留痕、hash 链完好；
 * assisted 员工同场景不阻塞（申报即过，直接 done）。
 * （注入式：不监听端口、不起定时器；handle 与 pipeline 共享同一 CheckReviewQueue。）
 */

const YAML = (taskId: string): string => `
taskId: ${taskId}
title: 盯梢任务 ${taskId}
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
tasks: [{ id: T-1, title: t, files: [src/main.js], requirement: r, acceptance: [a] }]
`;

let root: string;
let dataDir: string;
let sessionRoot: string;
let tasks: FileTaskStore;
let events: FileEventStore;
let handle: ReturnType<typeof createHandlers>;
let pipeline: RuntimePipeline;
let queue: CheckReviewQueue;

const profiles: EmployeeProfile[] = [
  { id: 'emp-01', name: '小数', role: 'backend', skills: ['backend'], supervision: { level: 'shadow' } },
  { id: 'emp-02', name: '小智', role: 'backend', skills: ['backend'], supervision: { level: 'assisted' } },
];

/** per-employee faux 脚本：emp-01 申报→驳回→修正重报→放行；emp-02（assisted）申报即过 */
const factories: Record<string, AgentFactory> = {
  'emp-01': (opts) => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('read_file', { path: 'src/main.js' })),
      fauxAssistantMessage(fauxToolCall('task_check', { item: 'T-1', result: '构建通过' })),
      // 被驳回（工具 error）后修正重新申报
      fauxAssistantMessage(fauxToolCall('task_check', { item: 'T-1', result: '补齐边界用例后构建通过' })),
      fauxAssistantMessage(fauxText('盯梢任务完成（emp-01）')),
    ]);
    return new Agent({
      initialState: { systemPrompt: opts.systemPrompt, model: faux.getModel(), tools: opts.tools },
      streamFn: models.streamSimple.bind(models),
    });
  },
  'emp-02': (opts) => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('task_check', { item: 'T-1', result: '自测通过' })),
      fauxAssistantMessage(fauxText('盯梢任务完成（emp-02）')),
    ]);
    return new Agent({
      initialState: { systemPrompt: opts.systemPrompt, model: faux.getModel(), tools: opts.tools },
      streamFn: models.streamSimple.bind(models),
    });
  },
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-sup-e2e-'));
  dataDir = await mkdtemp(join(tmpdir(), 'ddw-sup-e2e-data-'));
  sessionRoot = await mkdtemp(join(tmpdir(), 'ddw-sup-e2e-sess-'));

  // 事件总线 → 事件流落盘（员工事件与调度事件同源，hash 链保序）
  tasks = new FileTaskStore(dataDir);
  events = new FileEventStore(dataDir);
  const bus = new EventBus();
  bus.addSink({ write: (e) => events.append(e) });
  queue = new CheckReviewQueue();
  handle = createHandlers({ tasks, events, employees: profiles, reviewQueue: queue });

  const spec: ModelSpec = { name: 'glm', baseUrl: 'http://model-cluster.inner.bank/v1', apiKey: 'k', model: 'glm-5.3-flash' };
  const gateway = new ModelGateway([{ callType: 'code', primary: spec }]);

  const executor: EmployeeExecutor = createEmployeeExecutor({
    workspaceRoot: join(root, 'ws'),
    sessionsRoot: sessionRoot,
    gateway,
    events: bus,
    toolsFor: () => new ToolRegistry(),
    prepareWorkspace: async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'main.js'), '// 现场\n', 'utf8');
    },
    runtimeFor: ({ task, employee, workspaceDir }) => {
      const ws = new LocalWorkspace(workspaceDir);
      const toolRegistry = new ToolRegistry();
      for (const t of createWorkspaceTools(ws)) toolRegistry.register(t);
      const gate = employee.supervision?.level === 'shadow' ? gateForTask(queue, task.taskId) : undefined;
      return new EmployeeRuntime({
        gateway, tools: toolRegistry, interceptors: [], events: bus,
        sessions: new EmployeeSessionStore(join(sessionRoot, employee.id)),
        config: { employeeId: employee.id, supervision: employee.supervision, ...(gate ? { checkGate: gate } : {}) },
        agentFactory: factories[employee.id]!,
      });
    },
  });

  // startConsoleServer 同款装配；reviewQueue 注入实现 handle 与闸门共享（P10）
  pipeline = createRuntimePipeline(
    { tasks, events },
    {
      profiles,
      workspaceRoot: join(root, 'ws'),
      sessionsRoot: sessionRoot,
      routes: [{ callType: 'code', primary: spec }],
      executor,
      reviewQueue: queue,
    },
  );
}, 30_000);

afterAll(async () => {
  for (const dir of [root, dataDir, sessionRoot]) await rm(dir, { recursive: true, force: true });
});

/** 生产 tick 语义为只分派不等完成（P10）：轮询等待任务落定 */
async function waitTask(taskId: string, status: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = await tasks.get(taskId);
    if (rec?.status === status) return;
    if (Date.now() > deadline) throw new Error(`等待任务 ${taskId} → ${status} 超时（当前: ${rec?.status}）`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 轮询待审列表直到指定节点出现/消失 */
async function waitCheck(taskId: string, item: string, present: boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const checks = (await handle({ method: 'GET', path: '/api/checks' })).json as { taskId: string; item: string }[];
    const hit = checks.some((c) => c.taskId === taskId && c.item === item);
    if (hit === present) return;
    if (Date.now() > deadline) throw new Error(`等待待审节点 ${taskId}/${item}（期望${present ? '出现' : '清除'}）超时`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const review = (taskId: string, item: string, approved: boolean, comment?: string) =>
  handle({ method: 'POST', path: `/api/tasks/${taskId}/checks/${item}/review`, body: { approved, ...(comment ? { comment } : {}) } });

/** 等待 intervention 复核事件落库（POST review 200 只代表 resolver 已唤醒，事件写入是异步的） */
async function waitInterventions(taskId: string, minCount: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await handle({ method: 'GET', path: '/api/events', query: { taskId, type: 'intervention' } });
    if (((res.json as unknown[]).length ?? 0) >= minCount) return;
    if (Date.now() > deadline) throw new Error(`等待任务 ${taskId} 的 intervention 事件 ≥${minCount} 条超时`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('P10 端到端：人工盯梢闭环（shadow 阻塞/驳回/放行 × assisted 不阻塞）', () => {
  // 全量套件并发下轮询变慢，显式放宽用例超时（内部各 wait 上限 8s）
  it('shadow：申报阻塞→待审可见→驳回→修正重报→放行→done；assisted 直通；intervention 全程留痕', { timeout: 30_000 }, async () => {
    // 1. 页面粘 yaml 固化两个任务包（同岗位不同盯梢级别）
    const resA = await handle({ method: 'POST', path: '/api/tasks', body: YAML('TASK-SUP-A') });
    const resB = await handle({ method: 'POST', path: '/api/tasks', body: YAML('TASK-SUP-B') });
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    // 发布态（2026-09-06）：创建默认 draft，发布后才可被调度接取
    await handle({ method: 'POST', path: '/api/tasks/TASK-SUP-A/publish', body: {} });
    await handle({ method: 'POST', path: '/api/tasks/TASK-SUP-B/publish', body: {} });

    // 2. 生产语义 tick：只分派不等完成（两名员工各自领到任务）
    expect(await pipeline.scheduler.tick()).toBe(2);

    // 3. assisted 员工无闸门：task_check 申报即过，任务直接完成
    await waitTask('TASK-SUP-B', 'done');

    // 4. shadow 员工第一次申报 T-1 → 阻塞，控制台待审可见
    await waitCheck('TASK-SUP-A', 'T-1', true);
    const pending1 = (await handle({ method: 'GET', path: '/api/checks' })).json as { taskId: string; item: string; result: string }[];
    expect(pending1).toEqual([{ taskId: 'TASK-SUP-A', item: 'T-1', result: '构建通过' }]);

    // 5. 人工驳回（带意见）→ 员工收到工具错误，修正后重新申报
    //（旧待审被 intervention 事件清除、重报后重现——清除→重现间隔小于轮询周期，
    //  故不等待瞬时"已清空"窗口；配对清除语义由 review-gate 单测覆盖）
    const rej = await review('TASK-SUP-A', 'T-1', false, '边界用例没覆盖');
    expect(rej.status).toBe(200);
    await waitInterventions('TASK-SUP-A', 1); // 驳回留痕落库后，重报的待审才是"新"条目
    await waitCheck('TASK-SUP-A', 'T-1', true); // 重报后待审再次出现
    const pending2 = (await handle({ method: 'GET', path: '/api/checks' })).json as { result: string }[];
    expect(pending2).toEqual([{ taskId: 'TASK-SUP-A', item: 'T-1', result: '补齐边界用例后构建通过' }]);

    // 6. 人工放行 → 员工继续 → 任务完成，待审清空
    const ok = await review('TASK-SUP-A', 'T-1', true);
    expect(ok.status).toBe(200);
    await waitTask('TASK-SUP-A', 'done');
    await waitInterventions('TASK-SUP-A', 2); // 放行留痕落库（done 时必然已写入，此处显式等待避免与断言竞速）
    expect((await handle({ method: 'GET', path: '/api/checks' })).json).toEqual([]);

    // 7. 审计留痕：task_check x2（均 awaiting）+ intervention（驳回+放行），事件可溯
    const all = (await handle({ method: 'GET', path: '/api/events', query: { taskId: 'TASK-SUP-A' } })).json as {
      type: string; summary: string; payload?: Record<string, unknown>;
    }[];
    const checks = all.filter((e) => e.type === 'task_check');
    expect(checks).toHaveLength(2);
    expect(checks.every((e) => (e.payload as { awaiting: boolean }).awaiting === true)).toBe(true);
    const interventions = all.filter((e) => e.type === 'intervention');
    expect(interventions.map((e) => e.summary)).toEqual([
      '人工驳回节点 T-1：边界用例没覆盖',
      '人工放行节点 T-1',
    ]);

    // 8. hash 链全程完好：直播/审计/待审同源数据未被篡改
    const audit = (await handle({ method: 'GET', path: '/api/audit', query: { integrity: '1' } })).json as {
      integrity: { ok: boolean };
    };
    expect(audit.integrity.ok).toBe(true);

    // 9. 名册忙闲复位：两名员工全部空闲
    const roster = (await handle({ method: 'GET', path: '/api/employees' })).json as { id: string; busy: boolean }[];
    expect(roster.map((e) => e.busy)).toEqual([false, false]);
  });
});
