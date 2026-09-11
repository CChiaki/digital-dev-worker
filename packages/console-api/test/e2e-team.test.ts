import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import {
  EmployeeRuntime, EmployeeRoster, EmployeeSessionStore, EventBus,
  ModelGateway, ToolRegistry, LocalWorkspace, createWorkspaceTools,
  parseTaskPackage,
  type AgentFactory, type EmployeeProfile, type ModelSpec, type TaskPackage,
} from '@ddw/runtime';
import { createHandlers } from '../src/http/handlers.js';
import { FileTaskStore, FileEventStore } from '../src/stores/index.js';
import { TeamScheduler } from '../src/team/scheduler.js';
import { createEmployeeExecutor } from '../src/team/executor.js';

// 班组场景：TASK-A（后端）与 TASK-C（测试）无依赖可并行；TASK-B（后端，复用 emp-01）依赖 TASK-A
// 遗留收尾 T2（2026-09-08）：EmployeeRoster 对齐 role 精确匹配、skills 集合匹配退役——
// 原 fixture（emp-01 role=fullstack + skills=[backend,frontend] 跨岗接后端/前端任务）随之调整为同主岗任务。
const YAML = (taskId: string, opts: { role?: string; dependsOn?: string[] } = {}): string => `
taskId: ${taskId}
title: 班组任务 ${taskId}
${opts.role ? `role: ${opts.role}\n` : ''}${opts.dependsOn ? `dependsOn:\n${opts.dependsOn.map((d) => `  - ${d}`).join('\n')}\n` : ''}repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
tasks: [{ id: T-1, title: t, files: [src/main.js], requirement: r, acceptance: [a] }]
`;

// 各任务的 Faux 脚本：读文件 → 汇报（每个 runtime 只服务一个任务，队列一一对应）
const SCRIPTS: Record<string, { file: string; reply: string }> = {
  'TASK-A': { file: 'src/api.js', reply: '后端接口开发完成' },
  'TASK-B': { file: 'src/ui.js', reply: '前端页面开发完成' },
  'TASK-C': { file: 'test-plan.md', reply: '测试用例设计完成' },
};

let root: string;
let dataDir: string;
let sessionRoot: string;
let tasks: FileTaskStore;
let events: FileEventStore;
let handle: ReturnType<typeof createHandlers>;

const emp01: EmployeeProfile = { id: 'emp-01', name: '后端员工', role: 'backend', skills: ['backend'] };
const emp02: EmployeeProfile = { id: 'emp-02', name: '测试员工', role: 'test', skills: ['test'] };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-team-e2e-'));
  dataDir = await mkdtemp(join(tmpdir(), 'ddw-team-e2e-data-'));
  sessionRoot = await mkdtemp(join(tmpdir(), 'ddw-team-e2e-sess-'));

  tasks = new FileTaskStore(dataDir);
  events = new FileEventStore(dataDir);
  handle = createHandlers({ tasks, events });

  // 入库 3 个任务包
  const pkgs: TaskPackage[] = [
    parseTaskPackage(YAML('TASK-A', { role: 'backend' })),
    parseTaskPackage(YAML('TASK-C', { role: 'test' })),
    parseTaskPackage(YAML('TASK-B', { role: 'backend', dependsOn: ['TASK-A'] })),
  ];
  for (const p of pkgs) await tasks.add(p);
}, 30_000);

afterAll(async () => {
  for (const dir of [root, dataDir, sessionRoot]) await rm(dir, { recursive: true, force: true });
});

describe('P8 端到端：班组并行 + 包级依赖编排（3 任务包 × 2 员工）', () => {
  it('A/C 并行分派执行，B 等待 A done 后才分派，事件全程留痕可溯', async () => {
    // 事件总线 → 事件流留痕（runtime 员工事件 + scheduler 调度事件同源）
    const bus = new EventBus();
    bus.addSink({ write: (e) => events.append(e) });

    const spec: ModelSpec = { name: 'qwen', baseUrl: 'http://model.local/v1', apiKey: 'k', model: 'qwen3.8-27b' };
    const gateway = new ModelGateway([{ callType: 'code', primary: spec }]);

    const executor = createEmployeeExecutor({
      workspaceRoot: join(root, 'ws'),
      sessionsRoot: sessionRoot,
      gateway,
      events: bus,
      toolsFor: () => new ToolRegistry(),
      prepareWorkspace: async (dir, task) => {
        // 按任务预置现场文件（read_file 目标）
        const script = SCRIPTS[task.taskId]!;
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(join(dir, script.file), `// ${task.taskId} 现场\n`, 'utf8');
      },
      runtimeFor: ({ task, employee, workspaceDir }) => {
        // 真实 EmployeeRuntime：封闭工作区编码工具 + Faux 模型脚本（每任务一个 runtime，D2 单进程多实例）
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

    // —— 依赖编排视图（API）：TASK-B 尚未就绪 ——
    const before = await handle({ method: 'GET', path: '/api/tasks' });
    const listBefore = before.json as { taskId: string; depsState?: string; role?: string }[];
    expect(listBefore.find((t) => t.taskId === 'TASK-B')!.depsState).toBe('waiting');
    expect(listBefore.find((t) => t.taskId === 'TASK-B')!.role).toBe('backend');

    // —— 第一轮调度：A（backend→emp-01）与 C（test→emp-02）并行；B 等待 ——
    const sched = new TeamScheduler({ tasks, events, roster: new EmployeeRoster([emp01, emp02]), executor });
    const n1 = await sched.tick();
    expect(n1).toBe(2);

    expect((await tasks.get('TASK-A'))!.status).toBe('done');
    expect((await tasks.get('TASK-C'))!.status).toBe('done');
    expect((await tasks.get('TASK-B'))!.status).toBe('pending'); // 依赖未满足不分派

    // —— 第二轮调度：A 已 done，B 就绪分派给 emp-01（backend，同主岗）——
    const n2 = await sched.tick();
    expect(n2).toBe(1);
    expect((await tasks.get('TASK-B'))!.status).toBe('done');
    expect((await tasks.get('TASK-B'))!.claimedBy).toBe('emp-01');

    // —— 事件留痕：员工事件带 employeeId（并行可溯），调度事件按序 ——
    const all = (await events.list()) as { taskId: string; employeeId: string; type: string; summary: string }[];
    const aTool = all.find((e) => e.taskId === 'TASK-A' && e.type === 'tool_call');
    const cTool = all.find((e) => e.taskId === 'TASK-C' && e.type === 'tool_call');
    expect(aTool!.employeeId).toBe('emp-01');
    expect(cTool!.employeeId).toBe('emp-02');

    const dispatches = all.filter((e) => e.type === 'dispatch').map((e) => e.summary);
    expect(dispatches.some((s) => s.includes('TASK-A → emp-01'))).toBe(true);
    expect(dispatches.some((s) => s.includes('TASK-C → emp-02'))).toBe(true);
    // B 的分派必须晚于 A 的完成（依赖编排核心语义）
    const aDoneIdx = dispatches.findIndex((s) => s === '任务 TASK-A 完成（emp-01）');
    const bDispatchIdx = dispatches.findIndex((s) => s.includes('TASK-B → emp-01'));
    expect(aDoneIdx).toBeGreaterThanOrEqual(0);
    expect(bDispatchIdx).toBeGreaterThan(aDoneIdx);

    // —— 依赖视图翻转：B done 后无 depsState（无阻断）——
    const after = await handle({ method: 'GET', path: '/api/tasks' });
    const listAfter = after.json as { taskId: string; status: string; depsState?: string }[];
    expect(listAfter.find((t) => t.taskId === 'TASK-B')!.status).toBe('done');
    expect(listAfter.find((t) => t.taskId === 'TASK-B')!.depsState).toBeUndefined();
  }, 30_000);
});
