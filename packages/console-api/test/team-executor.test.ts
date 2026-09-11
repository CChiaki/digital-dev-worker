import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPABILITY_PRESETS } from '../src/team/capabilities.js';
import { createEmployeeExecutor, type EmployeeExecutorOptions } from '../src/team/executor.js';
import { parseTaskPackage, EmployeeSessionStore, loadMessages } from '@ddw/runtime';
import type { AgentEvent, EmployeeOutcome, ModelGateway, PlanItem, TaskPackage, ToolRegistry, EmployeeProfile } from '@ddw/runtime';

// plan-runner 打桩：捕获 runTaskPlan 入参（toolsForItem 组装断言用，不真跑 agent）
const { planInputs } = vi.hoisted(() => ({ planInputs: [] as unknown[] }));
vi.mock('../src/team/plan-runner.js', () => ({
  runTaskPlan: async (input: unknown) => {
    planInputs.push(input);
    return { status: 'done', reply: 'ok', turns: 0 };
  },
}));

let root: string;

beforeEach(async () => {
  planInputs.length = 0; // plan-runner 打桩捕获清空（用例间隔离）
  root = await mkdtemp(join(tmpdir(), 'ddw-team-exec-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const YAML = (taskId: string): string => `
taskId: ${taskId}
title: 测试任务
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
tasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]
`;

const PLAN_YAML = (taskId: string): string => `
taskId: ${taskId}
title: 计划测试任务
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
plan:
  - id: T-1
    title: 开发
    detail: d1
`;

const emp01: EmployeeProfile = { id: 'emp-01', name: '前端员工', role: 'frontend', skills: ['frontend'] };

/** 构造组装器：gateway/events/toolsFor 用最小 stub，runtimeFactory 捕获组装后的 runtime 配置 */
function makeExecutor(overrides: Partial<EmployeeExecutorOptions> = {}) {
  const captured: { wsDirs: string[]; sessionsDirs: string[]; configs: { employeeId?: string; supervision?: unknown }[] } = {
    wsDirs: [], sessionsDirs: [], configs: [],
  };
  const executor = createEmployeeExecutor({
    workspaceRoot: join(root, 'ws'),
    sessionsRoot: join(root, 'sessions'),
    gateway: {} as ModelGateway,
    events: { emit: async (_e: AgentEvent) => {}, emitBatch: async () => {} } as never,
    toolsFor: () => ({}) as ToolRegistry,
    ...overrides,
    runtimeFactory: (rt) => {
      // EmployeeRuntime deps 为 TS private（运行时可读），用于断言组装正确性
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deps = (rt as any).deps as { sessions: { root: string }; config: { employeeId?: string; supervision?: unknown } };
      captured.configs.push(deps.config);
      captured.sessionsDirs.push(deps.sessions.root);
      return {
        runTaskPackage: async (pkg: TaskPackage): Promise<EmployeeOutcome> => {
          captured.wsDirs.push(`run:${pkg.taskId}`);
          return { status: 'done', reply: `ok:${pkg.taskId}`, turns: 1 };
        },
      } as never;
    },
  });
  return { executor, captured };
}

describe('createEmployeeExecutor（员工执行器组装）', () => {
  it('按员工+任务隔离工作区目录，执行 runTaskPackage 并回传结果', async () => {
    const { executor, captured } = makeExecutor();
    const task = parseTaskPackage(YAML('TASK-A'));
    const outcome = await executor({ task, employee: emp01 });

    expect(outcome.reply).toBe('ok:TASK-A');
    const wsRoot = join(root, 'ws', 'emp-01');
    expect(await readdir(wsRoot)).toContain('TASK-A'); // taskId 目录
    expect(captured.wsDirs).toEqual(['run:TASK-A']);
  });

  it('supervision 随员工档案注入 runtime 配置；sessionId 目录按员工隔离', async () => {
    const { executor, captured } = makeExecutor();
    const emp02: EmployeeProfile = {
      id: 'emp-02', name: '后端员工', role: 'backend', skills: ['backend'],
      supervision: { level: 'trusted', extraCommands: ['docker'] },
    };
    await executor({ task: parseTaskPackage(YAML('TASK-B')), employee: emp02 });

    expect(captured.configs[0]).toEqual({ employeeId: 'emp-02', supervision: { level: 'trusted', extraCommands: ['docker'] } });
    expect(captured.sessionsDirs[0]).toContain(join('sessions', 'emp-02'));
  });

  it('prepareWorkspace 钩子在执行前被调用（可 git init / 预置代码）', async () => {
    const prepared: string[] = [];
    const { executor, captured } = makeExecutor({
      prepareWorkspace: async (dir, task, employee) => {
        prepared.push(`${employee.id}:${task.taskId}`);
      },
    });
    await executor({ task: parseTaskPackage(YAML('TASK-C')), employee: emp01 });
    expect(prepared).toEqual(['emp-01:TASK-C']);
    expect(captured.wsDirs).toEqual(['run:TASK-C']); // 预置先于执行
  });

  it('checkGate 仅注入 shadow 级员工（assisted/trusted 不阻塞，P10 盯梢闭环）', async () => {
    const { CheckReviewQueue, gateForTask } = await import('../src/team/review-gate.js');
    const queue = new CheckReviewQueue();
    const { executor, captured } = makeExecutor({
      checkGate: (taskId) => gateForTask(queue, taskId),
    });
    const shadow: EmployeeProfile = { id: 'emp-s', name: '盯梢期', role: 'backend', skills: ['backend'], supervision: { level: 'shadow' } };
    const assisted: EmployeeProfile = { id: 'emp-a', name: '辅助期', role: 'backend', skills: ['backend'], supervision: { level: 'assisted' } };
    const noLevel: EmployeeProfile = { id: 'emp-n', name: '未配置', role: 'backend', skills: ['backend'] };

    await executor({ task: parseTaskPackage(YAML('TASK-S')), employee: shadow });
    await executor({ task: parseTaskPackage(YAML('TASK-A2')), employee: assisted });
    await executor({ task: parseTaskPackage(YAML('TASK-N')), employee: noLevel });

    expect(captured.configs[0]).toMatchObject({ employeeId: 'emp-s', checkGate: { review: expect.any(Function) } });
    expect(captured.configs[1]).not.toHaveProperty('checkGate');
    expect(captured.configs[2]).not.toHaveProperty('checkGate');
    // 注入的 gate 与共享 queue 相通：wait 挂起后 queue.review 可唤醒
    const gate = (captured.configs[0] as { checkGate: { review: (c: { item: string; result: string; passed: boolean }) => Promise<unknown> } }).checkGate;
    const pending = gate.review({ item: 'T-1', result: 'x', passed: true });
    queue.review('TASK-S', 'T-1', true);
    expect(await pending).toEqual({ approved: true });
  });

  it('盯梢三级等级放权（2026-09-11）：shadow/assisted 白名单外挂审等人工放行，trusted 直接执行', async () => {
    const { CheckReviewQueue, gateForTask } = await import('../src/team/review-gate.js');
    const queue = new CheckReviewQueue();
    const mkLevel = (id: string, level: 'shadow' | 'assisted' | 'trusted'): EmployeeProfile =>
      ({ id, name: id, role: 'backend', skills: ['backend'], supervision: { level } });

    /** 跑一轮 plan 任务取 per-item 工具集，执行白名单外命令 whoami（白名单只有 echo） */
    const runCmd = async (taskId: string, employee: EmployeeProfile): Promise<{ ok: boolean; error?: string; data?: { stdout?: string } }> => {
      const { executor } = makeExecutor({
        checkGate: (tid) => gateForTask(queue, tid),
        bashWhitelist: ['echo'],
        capabilities: async () => CAPABILITY_PRESETS.map((d) => ({ ...d })),
      });
      await executor({ task: parseTaskPackage(PLAN_YAML(taskId)), employee });
      const input = planInputs[planInputs.length - 1] as { toolsForItem: (item: PlanItem, mcp: string[], builtin: string[]) => ToolRegistry };
      const tools = input.toolsForItem({ id: 'T-1', title: '开发', detail: 'd1' }, [], ['bash', 'files']);
      return tools.get('run_cmd')!.execute({ cmd: 'whoami' }) as never;
    };

    // shadow：白名单外命令挂起（叠加在节点申报闸门外）→ 人工放行后真实执行
    const shadowP = runCmd('TASK-LEV-S', mkLevel('emp-lev-s', 'shadow'));
    let shadowDone = false;
    void shadowP.then(() => { shadowDone = true; });
    await new Promise((r) => setTimeout(r, 80));
    expect(shadowDone).toBe(false);            // 未裁决前挂起
    queue.review('TASK-LEV-S', 'bash-1', true);
    expect(((await shadowP) as { ok: boolean }).ok).toBe(true);

    // assisted：同 shadow 的命令审批（节点申报不阻塞的差异在上一用例覆盖）
    const assistedP = runCmd('TASK-LEV-A', mkLevel('emp-lev-a', 'assisted'));
    let assistedDone = false;
    void assistedP.then(() => { assistedDone = true; });
    await new Promise((r) => setTimeout(r, 80));
    expect(assistedDone).toBe(false);
    queue.review('TASK-LEV-A', 'bash-1', true);
    expect(((await assistedP) as { ok: boolean }).ok).toBe(true);

    // trusted：不挂审不等人，白名单外直接执行（黑名单/组合命令仍硬拒——bash.test.ts 覆盖）
    const trustedR = await runCmd('TASK-LEV-T', mkLevel('emp-lev-t', 'trusted'));
    expect(trustedR.ok).toBe(true);
    expect(typeof trustedR.data?.stdout).toBe('string'); // 真实执行（whoami 有输出）

    // trusted 驳回路径不存在：没有待审条目可审（review 同步抛「待审节点不存在」）
    expect(() => queue.review('TASK-LEV-T', 'bash-1', false)).toThrow(/待审节点不存在/);
  });

  it('plan 任务的 per-item 工具集带上硬防线 backend（试点机 bwrap/docker 不静默退回 noop 直跑）', async () => {
    const wrapped: string[][] = [];
    const sentinel = { name: 'sentinel', wrap: (cmd: string[]) => { wrapped.push(cmd); return ['echo', 'sentinel']; } };
    const { executor } = makeExecutor({
      backend: sentinel as never,
      bashWhitelist: ['echo'],
      capabilities: async () => CAPABILITY_PRESETS.map((d) => ({ ...d })),
    });
    await executor({ task: parseTaskPackage(PLAN_YAML('TASK-PLAN-BE')), employee: emp01 });

    const input = planInputs[0] as { toolsForItem: (item: PlanItem, mcp: string[], builtin: string[]) => ToolRegistry };
    const tools = input.toolsForItem({ id: 'T-1', title: '开发', detail: 'd1' }, [], ['bash', 'files']);
    const bash = tools.get('run_cmd')!;
    const r = (await bash.execute({ cmd: 'echo hi' })) as { ok: boolean; data?: { stdout?: string } };
    expect(wrapped).toEqual([['echo', 'hi']]);       // 命令经注入的 backend.wrap（受控 bash 硬防线在场）
    expect(r.ok).toBe(true);
    expect(r.data?.stdout).toBe('sentinel\n');
  });

  it('未配置 backend 时 plan 工具集行为不变（Noop 直跑，零回归）', async () => {
    const { executor } = makeExecutor({
      bashWhitelist: ['echo'],
      capabilities: async () => CAPABILITY_PRESETS.map((d) => ({ ...d })),
    });
    await executor({ task: parseTaskPackage(PLAN_YAML('TASK-PLAN-NOOP')), employee: emp01 });
    const input = planInputs[0] as { toolsForItem: (item: PlanItem, mcp: string[], builtin: string[]) => ToolRegistry };
    const tools = input.toolsForItem({ id: 'T-1', title: '开发', detail: 'd1' }, [], ['bash', 'files']);
    const r = (await tools.get('run_cmd')!.execute({ cmd: 'echo hi' })) as { ok: boolean; data?: { stdout?: string } };
    expect(r.ok).toBe(true);
    expect(r.data?.stdout).toBe('hi\n');            // 直跑，无沙箱包装
  });

  it('从零执行清空该任务的 workspace 与 session 残留；续跑（progress 在场）保留一切（2026-09-06 任务重跑清空）', async () => {
    const { executor } = makeExecutor();
    const task = parseTaskPackage(PLAN_YAML('TASK-RESET'));
    const wsDir = join(root, 'ws', 'emp-01', 'TASK-RESET');
    const sessRoot = join(root, 'sessions', 'emp-01'); // executor 内部 root = join(sessionsRoot, employee.id)
    const open = () => new EmployeeSessionStore(sessRoot);

    // 预置上一轮残留：workspace 旧产物 + session 旧上下文
    await mkdir(wsDir, { recursive: true });
    await writeFile(join(wsDir, 'old.html'), '上一轮产物');
    const old = await open().open('TASK-RESET');
    await old.appendMessage({ role: 'user', content: [{ type: 'text', text: '旧上下文' }], timestamp: Date.now() } as never);

    // 从零重跑（progress 缺省）：两项全清
    await executor({ task, employee: emp01 });
    await expect(readdir(wsDir)).resolves.toEqual([]); // 目录重建且为空（mkdir recursive 保留）
    expect(await loadMessages(await open().open('TASK-RESET'))).toEqual([]); // session 是全新的

    // 断点续跑（progress 在场）：残留全保留
    await writeFile(join(wsDir, 'keep.html'), '续跑产物');
    const cont = await open().open('TASK-RESET');
    await cont.appendMessage({ role: 'user', content: [{ type: 'text', text: '续跑上下文' }], timestamp: Date.now() } as never);
    await executor({
      task, employee: emp01,
      progress: [{ itemId: 'T-1', kind: 'dev', title: '开发', status: 'done' }],
    });
    expect(await readFile(join(wsDir, 'keep.html'), 'utf8')).toBe('续跑产物');
    expect((await loadMessages(await open().open('TASK-RESET'))).some((m) => JSON.stringify(m).includes('续跑上下文'))).toBe(true);
  });
});
