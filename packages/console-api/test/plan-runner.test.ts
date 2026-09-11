import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTaskPlan, type PlanRunInput } from '../src/team/plan-runner.js';
import { FileCapabilityStore, CAPABILITY_PRESETS } from '../src/team/capabilities.js';
import type { CapabilityDef } from '../src/team/capabilities.js';
import type { DeployConfig } from '../src/team/runtime-config.js';
import { ToolRegistry, EventBus } from '@ddw/runtime';
import type { AgentEvent, AgentFactory, EmployeeProfile, ModelGateway, PlanItem, TaskPackage } from '@ddw/runtime';

/**
 * 计划执行器（2026-09-05，spec 任务计划模式）单测：
 * faux agent（prompt 即结束，outcome done）+ verify 执行器真跑（exec `exit 0`/`exit 1`）+
 * 事件内存收集 fake——进度/失败即停/续跑/启动校验/事件留痕断言真实。
 */

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-plan-runner-'));
  dataDir = root;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const pkg: TaskPackage & { plan: PlanItem[] } = {
  taskId: 'plan-1', title: '计划任务', repo: { url: 'http://x/a.git', branch: 'main' }, tasks: [],
  plan: [
    { id: 't1', title: '开发', detail: 'd1' },
    { id: 't2', kind: 'test', title: '测试', detail: 'd2', verify: 'exit 0' },
    { id: 't3', kind: 'commit', title: '提交', detail: 'd3' },
  ],
};

const emp: EmployeeProfile = { id: 'emp-01', name: '员工01', role: 'dev', skills: ['dev'] };

/** faux agent 工厂：prompt 即结束（员工侧正常 done，task_check 申报路径由 e2e/worker 覆盖） */
const fauxAgentFactory: AgentFactory = () =>
  ({
    subscribe: () => () => {},
    prompt: async () => {},
    steer: () => false,
    state: { messages: [] },
  }) as never;

/** faux agent 工厂：模拟 pi agent 逐轮循环直至撞轮次上限（outcome.status='max_turns'） */
const maxTurnsAgentFactory: AgentFactory = () => {
  const agent: Record<string, unknown> = {
    subscribe: () => () => {},
    steer: () => false,
    state: { messages: [] },
    prompt: async () => {
      // 与 pi Agent 循环契约一致：每轮咨询 shouldStopAfterTurn（runtime 注入），返回 true 即止
      const stop = agent.shouldStopAfterTurn as () => Promise<boolean>;
      while (!(await stop())) { /* 下一轮 */ }
    },
  };
  return agent as never;
};

/** faux gateway：faux agent 不触达模型，仅组装时解析路由需方法在场 */
const fauxGateway = {
  modelFor: () => ({}),
  streamFnFor: () => (async () => {}) as never,
} as unknown as ModelGateway;

interface DepsOpts {
  /** t2 的 verify 命令退出码（执行器真跑 `exit N`） */
  verifyResult?: number;
  /** 工具集打点：toolsForItem 记录执行的项 id */
  executed?: string[];
  /** commit 项 forge 配置存在性（缺省在场） */
  forge?: unknown;
  /** devops 项 deploy 配置存在性（缺省未配置） */
  deploy?: DeployConfig;
  /** 事件收集数组（内存收集 fake：EventBus sink 写入） */
  events?: AgentEvent[];
  /** 能力定义（缺省预置四类） */
  capabilities?: CapabilityDef[];
  /** agent 工厂覆盖（max_turns 用例等） */
  agentFactory?: AgentFactory;
  /** faux agent prompt 期间发一条失败的该工具调用事件（关键工具核对用例） */
  failToolDuring?: string;
  /** 失败事件之后紧随一条同工具成功事件（模型被拒后重试成功，护栏不得误杀） */
  toolRecoverAfterFail?: boolean;
}

function makeDeps(opts: DepsOpts = {}): Omit<PlanRunInput, 'pkg' | 'employee'> & { executed: string[] } {
  // verify 真跑：把 pkg.t2 的验证命令按用例退出码改写（`exit 0` / `exit 1`）
  const testItem = pkg.plan!.find((it) => it.id === 't2');
  if (testItem) testItem.verify = `exit ${opts.verifyResult ?? 0}`;

  const collected = opts.events ?? [];
  const events = new EventBus();
  events.addSink({ write: async (e) => { collected.push(e); } });

  const executed = opts.executed ?? [];
  const workspaceDir = join(root, 'ws');
  // verify exec 以工作区为 cwd（执行器亲自跑真命令，目录须真实存在）
  mkdirSync(workspaceDir, { recursive: true });
  // faux agent：prompt 期间向总线发一条失败的该工具调用（关键工具核对用例）
  const failToolFactory: AgentFactory = () =>
    ({
      subscribe: () => () => {},
      prompt: async () => {
        await events.emit({
          id: 'tool-err', ts: Date.now(), taskId: 'plan-1', employeeId: emp.id,
          type: 'tool_call', summary: opts.failToolDuring!,
          payload: { toolCallId: 'c1', result: { ok: false, error: 'boom' }, isError: true },
        });
        if (opts.toolRecoverAfterFail) {
          await events.emit({
            id: 'tool-ok', ts: Date.now() + 1, taskId: 'plan-1', employeeId: emp.id,
            type: 'tool_call', summary: opts.failToolDuring!,
            payload: { toolCallId: 'c2', result: { ok: true, data: {} }, isError: false },
          });
        }
      },
      steer: () => false,
      state: { messages: [] },
    }) as never;
  return {
    workspaceDir,
    sessionsRoot: join(root, 'sessions'),
    gateway: fauxGateway,
    events,
    agentFactory: opts.failToolDuring ? failToolFactory : (opts.agentFactory ?? fauxAgentFactory),
    // provider 包装（计划执行器每项执行前重新查表）：缺省预置四类的拷贝
    capabilities: async () => opts.capabilities ?? CAPABILITY_PRESETS.map((d) => ({ ...d })),
    // 仅存在性判断：'forge' in opts 区分「未配置」与缺省在场
    forge: 'forge' in opts ? opts.forge : {},
    ...(opts.deploy ? { deploy: opts.deploy } : {}),
    toolsForItem: (item: { id: string }) => {
      executed.push(item.id);
      return new ToolRegistry();
    },
    executed,
  };
}

describe('runTaskPlan（计划执行器，2026-09-05）', () => {
  it('逐项执行：全部通过 → outcome.planProgress 三项 done，无 failedItemId', async () => {
    const input = makeDeps({ verifyResult: 0 });
    const outcome = await runTaskPlan({ pkg, employee: emp, ...input });
    expect(outcome.status).toBe('done');
    expect(outcome.planProgress!.map((p) => [p.itemId, p.status])).toEqual([['t1','done'],['t2','done'],['t3','done']]);
    expect(outcome.failedItemId).toBeUndefined();
  });

  it('token 用量任务级累计（2026-09-11 P2 产品批）：每项独立 runtime 实例，账本在计划执行器层求和', async () => {
    // faux agent：prompt 期间回放原始 pi message_end(assistant).usage 事件（每项 100/20）
    const usageAgentFactory: AgentFactory = () => {
      // 订阅者列表（真实 pi agent 语义）：runtime 记账与 wireSession 落盘各持一份订阅，不可互相覆盖
      const subs: ((e: unknown) => void)[] = [];
      return {
        subscribe: (fn: (e: unknown) => void) => { subs.push(fn); return () => {}; },
        prompt: async () => {
          for (const fn of subs) fn({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '本项完成' }], usage: { input: 100, output: 20 } } });
        },
        steer: () => false,
        state: { messages: [] },
      } as never;
    };
    const events: AgentEvent[] = [];
    const outcome = await runTaskPlan({ pkg, employee: emp, ...makeDeps({ verifyResult: 0, agentFactory: usageAgentFactory, events }) });
    // 三项各 100/20 → 任务总量 300/60/3（outcome 携带，调度器 finish 落库 result）
    expect(outcome.tokenUsage).toEqual({ input: 300, output: 60, calls: 3 });
    // 每项收尾各留一条该项用量的 report 留痕（runtime 实例账本只记当项）；
    // 任务总量由计划执行器合成进 outcome（上一断言），不重复发事件
    const usageReports = events.filter((e) => e.type === 'report' && (e.payload as { tokenUsage?: unknown } | undefined)?.tokenUsage);
    expect(usageReports).toHaveLength(3);
    for (const r of usageReports) expect(r.payload).toMatchObject({ tokenUsage: { input: 100, output: 20, calls: 1 } });
  });

  it('retryPerItem：首次失败重跑成功 → 全项 done，retry 留痕事件 + 两轮用量入账', async () => {
    // verify 首跑建 marker 退出 1，重试时 marker 在场通过——模拟「第一次没做好，第二次修正」
    const flip = `test -f ${root}/flip-marker || { touch ${root}/flip-marker; exit 1; }`;
    const events: AgentEvent[] = [];
    const usageAgentFactory: AgentFactory = () => {
      const subs: ((e: unknown) => void)[] = [];
      return {
        subscribe: (fn: (e: unknown) => void) => { subs.push(fn); return () => {}; },
        prompt: async () => {
          for (const fn of subs) fn({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '完成' }], usage: { input: 10, output: 2 } } });
        },
        steer: () => false,
        state: { messages: [] },
      } as never;
    };
    const deps = makeDeps({ events, agentFactory: usageAgentFactory });
    pkg.plan!.find((it) => it.id === 't2')!.verify = flip;
    const outcome = await runTaskPlan({ pkg, employee: emp, retryPerItem: 1, ...deps });
    expect(outcome.planProgress!.map((p) => p.status)).toEqual(['done', 'done', 'done']);
    // retry 留痕：payload.plan.phase='retry' 带第几次尝试与失败原因
    const retries = events.filter((e) => (e.payload as { plan?: { phase?: string } } | undefined)?.plan?.phase === 'retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]!.payload).toMatchObject({ plan: { itemId: 't2', attempt: 1 } });
    // 两次尝试的用量都入账（诚实成本：t1 一次 + t2 两次 + t3 一次 = 4 次调用）
    expect(outcome.tokenUsage).toMatchObject({ calls: 4, input: 40, output: 8 });
  });

  it('retryPerItem 耗尽：每次都失败 → failed 即停（重试后），后续 skipped；缺省 0 = 单次即停', async () => {
    // 重试耗尽路径：t2 verify 恒失败 + retryPerItem=1 → t2 执行两次后 failed
    let attempts = 0;
    const countingFactory: AgentFactory = () => {
      const subs: ((e: unknown) => void)[] = [];
      return {
        subscribe: (fn: (e: unknown) => void) => { subs.push(fn); return () => {}; },
        prompt: async () => { attempts++; for (const fn of subs) fn({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] } }); },
        steer: () => false,
        state: { messages: [] },
      } as never;
    };
    const deps1 = makeDeps({ verifyResult: 1, agentFactory: countingFactory });
    const o1 = await runTaskPlan({ pkg, employee: emp, retryPerItem: 1, ...deps1 });
    expect(o1.planProgress!.map((p) => p.status)).toEqual(['done', 'failed', 'skipped']);
    expect(attempts).toBe(3); // t1 一次 + t2 两次（1 次原始 + 1 次重试）

    // 缺省 0：单次执行即停（现状语义零回归）
    attempts = 0;
    const deps2 = makeDeps({ verifyResult: 1, agentFactory: countingFactory });
    const o2 = await runTaskPlan({ pkg, employee: emp, ...deps2 });
    expect(o2.planProgress!.map((p) => p.status)).toEqual(['done', 'failed', 'skipped']);
    expect(attempts).toBe(2); // t1 一次 + t2 单次
  });

  it('失败即停：t2 verify 非零 → t2 failed、t3 skipped，failedItemId=t2', async () => {
    const input = makeDeps({ verifyResult: 1 });
    const outcome = await runTaskPlan({ pkg, employee: emp, ...input });
    expect(outcome.status).toBe('done');            // 员工侧正常结束；链停语义由 progress 表达
    expect(outcome.failedItemId).toBe('t2');
    expect(outcome.planProgress!.map((p) => p.status)).toEqual(['done', 'failed', 'skipped']);
  });

  it('startFrom 续跑：progress 里 t1 done 不重做，从 t2 开始', async () => {
    const input = makeDeps({ verifyResult: 0, executed: [] });
    await runTaskPlan({ pkg, employee: emp, ...input,
      progress: [{ itemId: 't1', kind: 'dev', title: '开发', status: 'done' }] });
    expect(input.executed).toEqual(['t2', 't3']);   // t1 未再次执行
  });

  it('未注册 kind 启动即报错可读（不带病执行）', async () => {
    const bad: TaskPackage & { plan: PlanItem[] } = { ...pkg, plan: [{ id: 'x', kind: 'nope', title: 't', detail: 'd' }] };
    await expect(runTaskPlan({ pkg: bad, employee: emp, ...makeDeps({ verifyResult: 0 }) }))
      .rejects.toThrow(/任务项 x\.kind='nope' 未注册或已停用/);
  });

  it('kind 依赖的 MCP 未配置 → 启动即报错（commit 需 forge 配置）', async () => {
    const caps = new FileCapabilityStore(join(dataDir, 'caps.json'));
    await caps.ensureSeed();
    await expect(runTaskPlan({ pkg, employee: emp, ...makeDeps({ verifyResult: 0, forge: undefined, capabilities: await caps.list() }) }))
      .rejects.toThrow(/能力 commit 依赖 forge 工具包，但运行时未配置/);
  });

  it('max_turns 短路 verify：撞轮次上限即失败，不跑 verify（failReason 不被覆盖）', async () => {
    // 首项 verify 'exit 1'：若 verify 先跑，failReason 会被覆盖为「验证命令失败」
    const maxPkg: TaskPackage & { plan: PlanItem[] } = {
      ...pkg,
      plan: [{ id: 't1', title: '开发', detail: 'd1', verify: 'exit 1' }, ...pkg.plan.slice(1)],
    };
    const collected: AgentEvent[] = [];
    const input = makeDeps({ verifyResult: 1, events: collected, agentFactory: maxTurnsAgentFactory });
    const outcome = await runTaskPlan({ pkg: maxPkg, employee: emp, ...input });
    expect(outcome.status).toBe('done');
    expect(outcome.failedItemId).toBe('t1');
    expect(outcome.reply).toContain('达到轮次上限（max_turns=40）');
    expect(outcome.reply).not.toContain('验证命令失败');
    expect(outcome.planProgress!.map((p) => p.status)).toEqual(['failed', 'skipped', 'skipped']);
    const failEvt = collected.find((e) => (e.payload as { plan?: { phase?: string } }).plan?.phase === 'failed');
    expect((failEvt!.payload as { plan: { reason: string } }).plan.reason).toBe('达到轮次上限（max_turns=40）');
  });

  it('maxTurns 从 PlanRunInput 透传到 EmployeeRuntime：上限值即停止轮数，reason 反映生效配置', async () => {
    // 链路证明（2026-09-10 排查）：input.maxTurns → assembleDefaultRuntime → config.maxTurns。
    // faux agent 逐轮咨询 shouldStopAfterTurn，runtime 在 maxTurns 轮返回 true——
    // reason 带 max_turns=3 即证明配置贯通（缺省 40 时不透传则此处仍会打 40）
    const collected: AgentEvent[] = [];
    const input = makeDeps({ verifyResult: 1, events: collected, agentFactory: maxTurnsAgentFactory });
    const outcome = await runTaskPlan({ pkg, employee: emp, ...input, maxTurns: 3 });
    expect(outcome.failedItemId).toBe('t1');
    expect(outcome.reply).toContain('达到轮次上限（max_turns=3）');
  });

  it('每项开始/完成/失败 emit 事件留痕（type=report，payload.plan）', async () => {
    const collected: AgentEvent[] = [];
    const input = makeDeps({ verifyResult: 0, events: collected });
    await runTaskPlan({ pkg, employee: emp, ...input });
    const planEvents = collected.filter((e) => (e.payload as { plan?: unknown }).plan !== undefined);
    expect(planEvents.length).toBeGreaterThanOrEqual(6); // 3 项 × start/done
  });

  it('运行中改注册表：每项执行前重新查表——t1 后停用 test，t2 报未注册失败即停（spec §5）', async () => {
    const executed: string[] = [];
    const caps: CapabilityDef[] = CAPABILITY_PRESETS.map((d) => ({ ...d }));
    const input = makeDeps({ verifyResult: 0, executed });
    // provider：t1 执行后把 test 停用（模拟运行中注册表被改）
    input.capabilities = async () => {
      if (executed.includes('t1')) {
        const test = caps.find((c) => c.kind === 'test');
        if (test) test.enabled = false;
      }
      return caps;
    };
    const outcome = await runTaskPlan({ pkg, employee: emp, ...input });
    expect(outcome.status).toBe('done');
    expect(outcome.failedItemId).toBe('t2');
    expect(outcome.reply).toContain("kind='test' 未注册或已停用");
    expect(outcome.planProgress!.map((p) => p.status)).toEqual(['done', 'failed', 'skipped']);
    expect(executed).toEqual(['t1']); // t3 未执行（失败即停）
  });

  it('关键工具调用失败 → 该项 failed（执行器核对工具结果，不采信申报；spec §3.1/§5，2026-09-05）', async () => {
    const devopsPkg: TaskPackage & { plan: PlanItem[] } = {
      taskId: 'plan-1', title: 'x', repo: { url: 'http://x/a.git', branch: 'main' }, tasks: [],
      plan: [
        { id: 't1', kind: 'devops', title: '发布', detail: 'd' },
        { id: 't2', kind: 'commit', title: '提交', detail: 'd' },
      ],
    };
    const input = makeDeps({
      verifyResult: 0,
      failToolDuring: 'deploy_to_env',
      deploy: { envs: [{ name: 'web', artifactDir: '/x' }] },
    });
    const outcome = await runTaskPlan({ pkg: devopsPkg, employee: emp, ...input });
    expect(outcome.status).toBe('done');
    expect(outcome.failedItemId).toBe('t1');
    expect(outcome.reply).toContain('关键工具调用失败');
    expect(outcome.reply).toContain('deploy_to_env');
    expect(outcome.planProgress!.map((p) => p.status)).toEqual(['failed', 'skipped']);
  });

  it('非关键工具失败（run_cmd）不触发客观核对拦截——bash 失败是 dev/test 日常语义', async () => {
    const input = makeDeps({ verifyResult: 0, failToolDuring: 'run_cmd' });
    const outcome = await runTaskPlan({ pkg, employee: emp, ...input });
    expect(outcome.failedItemId).toBeUndefined();
    expect(outcome.planProgress!.map((p) => p.status)).toEqual(['done', 'done', 'done']);
  });

  it('关键工具失败后模型重试成功 → 不误杀（每工具取最后一次调用状态，2026-09-05 实战 t3）', async () => {
    // 实战场景：整包提交超模型输出 token 上限被拒（isError）→ 模型拆单重提成功 →
    // 护栏若凭"出现过 isError"算账会把成功项误判 failed
    const devopsPkg: TaskPackage & { plan: PlanItem[] } = {
      taskId: 'plan-1', title: 'x', repo: { url: 'http://x/a.git', branch: 'main' }, tasks: [],
      plan: [
        { id: 't1', kind: 'commit', title: '提交', detail: 'd' },
        { id: 't2', kind: 'devops', title: '发布', detail: 'd' },
      ],
    };
    const input = makeDeps({
      verifyResult: 0,
      failToolDuring: 'gitea_commit_files',
      toolRecoverAfterFail: true,
      deploy: { envs: [{ name: 'web', artifactDir: '/x' }] },
    });
    const outcome = await runTaskPlan({ pkg: devopsPkg, employee: emp, ...input });
    expect(outcome.status).toBe('done');
    expect(outcome.failedItemId).toBeUndefined();
    expect(outcome.planProgress!.map((p) => p.status)).toEqual(['done', 'done']);
  });

  it('关键工具重试成功后再次失败 → 仍判 failed（最后一次状态为准，双向）', async () => {
    // 反向：成功后同工具再失败，最后一次状态是 isError → 必须拦截
    const devopsPkg: TaskPackage & { plan: PlanItem[] } = {
      taskId: 'plan-1', title: 'x', repo: { url: 'http://x/a.git', branch: 'main' }, tasks: [],
      plan: [{ id: 't1', kind: 'devops', title: '发布', detail: 'd' }],
    };
    // 复用 recover 开关：先发成功再发失败 —— 通过两次 prompt 事件顺序实现
    // （failToolFactory 目前是先失败后成功；这里直接用自定义 agentFactory 构造先成功后失败）
    const input = makeDeps({ verifyResult: 0 });
    const events = input.events;
    const agentFactory: AgentFactory = () =>
      ({
        subscribe: () => () => {},
        prompt: async () => {
          await events.emit({
            id: 'tool-ok', ts: Date.now(), taskId: 'plan-1', employeeId: emp.id,
            type: 'tool_call', summary: 'deploy_to_env',
            payload: { toolCallId: 'c1', result: { ok: true, data: {} }, isError: false },
          });
          await events.emit({
            id: 'tool-err', ts: Date.now() + 1, taskId: 'plan-1', employeeId: emp.id,
            type: 'tool_call', summary: 'deploy_to_env',
            payload: { toolCallId: 'c2', result: { ok: false, error: 'boom' }, isError: true },
          });
        },
        steer: () => false,
        state: { messages: [] },
      }) as never;
    const outcome = await runTaskPlan({
      pkg: devopsPkg, employee: emp, ...input, agentFactory,
      deploy: { envs: [{ name: 'web', artifactDir: '/x' }] },
    });
    expect(outcome.failedItemId).toBe('t1');
    expect(outcome.reply).toContain('关键工具调用失败');
  });

  // ---- 2026-09-11 事故修复回归 ----
  // 真实事故：grep 命中 minified 产物把模型上下文撑爆（400），pi 落 stopReason=error 空消息
  // 正常结束循环，runtime 假 done → 计划 5 项逐项「秒完成」，0 实际动作 0 人工节点
  it('模型错误收尾（status=error）→ 本项 failed 且短路 verify，后续 skipped（不再假 done）', async () => {
    // t1 带 verify 'exit 1'：若 error 未短路 verify，failReason 会被覆盖为「验证命令失败」
    const errPkg: TaskPackage & { plan: PlanItem[] } = {
      ...pkg,
      plan: [{ id: 't1', title: '开发', detail: 'd1', verify: 'exit 1' }, ...pkg.plan.slice(1)],
    };
    const errFactory: AgentFactory = () =>
      ({
        subscribe: () => () => {},
        prompt: async () => {},
        steer: () => false,
        state: {
          messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: '400: maximum context length is 262144 tokens' }],
        },
      }) as never;
    const input = makeDeps({ verifyResult: 1, agentFactory: errFactory });
    const outcome = await runTaskPlan({ pkg: errPkg, employee: emp, ...input });
    expect(outcome.failedItemId).toBe('t1');
    expect(outcome.reply).toContain('模型调用失败');
    expect(outcome.reply).toContain('maximum context length');
    expect(outcome.reply).not.toContain('验证命令失败');  // verify 被短路
    expect(outcome.planProgress!.map((p) => p.status)).toEqual(['failed', 'skipped', 'skipped']);
  });

  it('盯梢期（shadow）未申报 task_check 即结束 → 本项 failed（放行闸门不得被绕过）', async () => {
    // 员工侧正常 done 但全程无 task_check 申报——此前静默标完成，shadow 闸门形同虚设
    const shadowEmp: EmployeeProfile = { ...emp, supervision: { level: 'shadow' } };
    const input = makeDeps({ verifyResult: 0 });
    const outcome = await runTaskPlan({ pkg, employee: shadowEmp, ...input });
    expect(outcome.failedItemId).toBe('t1');
    expect(outcome.reply).toContain('盯梢期未申报 task_check');
  });

  it('盯梢期（shadow）申报成功（tool_call isError=false）→ 正常通过；非 shadow 员工不强制', async () => {
    const shadowEmp: EmployeeProfile = { ...emp, supervision: { level: 'shadow' } };
    const input = makeDeps({ verifyResult: 0 });
    const events = input.events;
    const declaringFactory: AgentFactory = () =>
      ({
        subscribe: () => () => {},
        prompt: async () => {
          await events.emit({
            id: 'chk-ok', ts: Date.now(), taskId: 'plan-1', employeeId: shadowEmp.id,
            type: 'tool_call', summary: 'task_check',
            payload: { toolCallId: 'c1', result: { ok: true, data: {} }, isError: false },
          });
        },
        steer: () => false,
        state: { messages: [] },
      }) as never;
    const outcome = await runTaskPlan({ pkg, employee: shadowEmp, ...input, agentFactory: declaringFactory });
    expect(outcome.failedItemId).toBeUndefined();
    expect(outcome.planProgress!.map((p) => p.status)).toEqual(['done', 'done', 'done']);

    // 对照组：同样不申报，非 shadow 员工保持既有语义（申报仅为留痕）→ 通过
    const plainInput = makeDeps({ verifyResult: 0 });
    const plain = await runTaskPlan({ pkg, employee: emp, ...plainInput });
    expect(plain.failedItemId).toBeUndefined();
  });
});
