import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  EventBus, ModelGateway, EmployeeSessionStore,
  type AgentEvent, type AgentFactory, type CheckGate, type EmployeeOutcome, type EmployeeProfile, type PlanItem,
  type PlanProgress, type RouteConfig, type TaskPackage,
} from '@ddw/runtime';
import { assembleDefaultRuntime } from './executor.js';
import { runTaskPlan } from './plan-runner.js';
import { defaultToolsFor, makeBackend, repoPathFromUrl, type BackendKind } from './default-tools.js';
import { makeBashApproval } from './bash-approval.js';
import { bashPolicyFor } from './supervision-policy.js';
import { prepareTaskWorkspace } from './workspace-prepare.js';
import { McpHub, type McpServerConfig } from './mcp-hub.js';
import type { CapabilityDef } from './capabilities.js';
import type { DeployConfig, ForgeConfig } from './runtime-config.js';
import type { SkillRecord } from './skill-store.js';

/**
 * fork worker 入口（P13 多进程横向扩展）：每任务一个子进程，跑完即退——
 * 崩溃隔离（员工进程崩不拖死控制台）、CPU/IO 密集执行不影响 API 响应。
 * 事件经 IPC 回主进程统一 append（hash 链保序 = 主进程到达序，worker 不直接写 store）；
 * shadow 人工放行闸门跨进程往返（gate-wait → 主进程 reviewQueue → gate-verdict）。
 */

/** 主进程 → worker 的任务载荷（IPC 只能带 JSON，backend/gate 都以字面量+协议表达） */
export interface WorkerJob {
  task: TaskPackage;
  employee: EmployeeProfile;
  /** 计划续跑：已有个项进度（done 项跳过，从停点续） */
  progress?: PlanProgress[];
  config: {
    /** 模型路由（chat/code/review/test），worker 内自建 ModelGateway */
    routes: RouteConfig[];
    /** bash 白名单（首 token，ControlledBash 软防线） */
    bashWhitelist?: string[];
    /** 受控 bash 单条命令超时毫秒（缺省 60s）：构建类命令按需放大 */
    bashTimeoutMs?: number;
    /** 每任务最大对话轮数（yaml maxTurns；缺省 EmployeeRuntime 内置 40） */
    maxTurns?: number;
    /** 计划模式每项失败自动重试次数（2026-09-11 P2 产品批 yaml 可配；缺省 0 = 失败即停） */
    retryPerItem?: number;
    /** 执行层硬防线 backend 类型字面量 */
    backendKind: BackendKind;
    workspaceRoot: string;
    sessionsRoot: string;
    /** agent 工厂模块路径（e2e/测试注入 faux；模块需导出 agentFactory） */
    agentModulePath?: string;
    /** 代码托管协作（可选）：注入 建分支/提交/建 MR 工具（provider: gitlab/gitea）；defaultRepo 由任务包 repo.url 推导 */
    forge?: ForgeConfig;
    /** 能力定义快照（计划模式 per-item 工具集；分派时刻快照，后台改动对后续分派生效） */
    capabilities?: CapabilityDef[];
    /** 发布部署配置（devops 项） */
    deploy?: DeployConfig;
    /** 标准 MCP server 注册快照（2026-09-06 用户需求 B）：worker 子进程内自建 McpHub
     *  （连接无法走 IPC，快照 JSON 传配置、子进程按配置连） */
    mcpServers?: McpServerConfig[];
    /** Skill 快照（2026-09-06）：分派时刻按员工分类过滤的 approved 清单（IPC JSON，fork 天生快照） */
    skills?: SkillRecord[];
    /** 员工专属模型路由（2026-09-06 一人一模型一 key，可选）：worker 构造 gateway 时
     *  追加尾部覆盖同 callType（ModelGateway 用 Map 同 callType 后者胜）；缺省全局零回归 */
    employeeRoute?: RouteConfig;
    /** 跳过任务工作区 clone（2026-09-06 实战修复配套，测试/faux agent 场景注入）；
     *  生产缺省执行 prepareTaskWorkspace（repo.url 不可达即失败留痕） */
    skipWorkspacePrepare?: boolean;
  };
}

/** worker → 主进程消息 */
export type WorkerToMain =
  | { type: 'event'; event: AgentEvent }
  | { type: 'gate-wait'; requestId: string; check: { taskId: string; item: string; result: string; passed: boolean } }
  | { type: 'done'; outcome: EmployeeOutcome }
  | { type: 'error'; message: string };

/** 主进程 → worker 消息 */
export type MainToWorker =
  | { type: 'job'; job: WorkerJob }
  | { type: 'gate-verdict'; requestId: string; verdict: { approved: boolean; comment?: string } };

/**
 * worker 运行体（依赖注入 io 便于单测；fork 子进程由 cli 装配处接 process.send/on）：
 * 收 job → 组装（复用 assembleDefaultRuntime，与 in-process 同一处实现）→ 执行 → done/error。
 */
export function runWorker(io: {
  send: (msg: WorkerToMain) => void;
  onMessage: (handler: (msg: MainToWorker) => void) => void;
}): void {
  const gateResolvers = new Map<string, (v: { approved: boolean; comment?: string }) => void>();

  const checkGate = (taskId: string): CheckGate => ({
    review: (check) => {
      const requestId = randomUUID();
      return new Promise((resolve) => {
        gateResolvers.set(requestId, resolve);
        io.send({ type: 'gate-wait', requestId, check: { taskId, ...check } });
      });
    },
  });

  io.onMessage((msg) => {
    if (msg.type === 'gate-verdict') {
      const resolve = gateResolvers.get(msg.requestId);
      if (!resolve) return; // 迟到/作废的复核（任务已结束）——忽略
      gateResolvers.delete(msg.requestId);
      resolve(msg.verdict);
      return;
    }
    if (msg.type !== 'job') return;
    void runJob(msg.job).then(
      (outcome) => io.send({ type: 'done', outcome }),
      (err) => io.send({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  });

  async function runJob(job: WorkerJob): Promise<EmployeeOutcome> {
    const { task, employee, progress, config } = job;
    const wsDir = join(config.workspaceRoot, employee.id, task.taskId.replaceAll('/', '_'));
    // 从零执行（progress 缺省）先清残留：与 inproc executor 语义一致（2026-09-06）；
    // 断点续跑（progress 在场）保留一切——resumeWith 依赖同会话延续与既有产物
    if (!progress) {
      await rm(wsDir, { recursive: true, force: true });
      await new EmployeeSessionStore(join(config.sessionsRoot, employee.id)).remove(task.taskId);
    }
    await mkdir(wsDir, { recursive: true });
    // 任务工作区 clone（2026-09-06 实战修复，与 inproc executor 的 prepareWorkspace 钩子同语义）：
    // 执行前按 repo.url 拉代码 + 检出工作分支；续跑现场（非空目录）幂等跳过
    if (!config.skipWorkspacePrepare) await prepareTaskWorkspace(wsDir, task, config.forge);

    // worker 内 EventBus：仅作事件转发管道（emit 填 id/ts 保序），落库在主进程侧
    const bus = new EventBus();
    bus.addSink({ write: async (e) => { io.send({ type: 'event', event: e }); } });

    // MCP server 连接（2026-09-06 用户需求 B）：连接无法走 IPC，子进程按配置快照自建；
    // start 容错（单 server 失败留痕不炸任务），仅 plan 模式的 toolsForItem 消费
    let workerMcpHub: McpHub | undefined;
    if (config.mcpServers?.length) {
      workerMcpHub = new McpHub(config.mcpServers);
      await workerMcpHub.start();
    }

    let agentFactory: AgentFactory | undefined;
    if (config.agentModulePath) {
      const mod = await import(config.agentModulePath) as { agentFactory?: AgentFactory };
      if (!mod.agentFactory) throw new Error(`agent 模块缺 agentFactory 导出: ${config.agentModulePath}`);
      agentFactory = mod.agentFactory;
    }

    // 白名单外命令人工放行（2026-09-11 盯梢三级改等级驱动）：shadow/assisted 挂审，闸门 = IPC 桥
    // checkGate（gate-wait/verdict 与主进程 CheckReviewQueue 同源），审批事件经 bus 回主进程；
    // trusted 由策略 bypassWhitelist 直接执行（黑名单/组合命令仍硬拒）
    const bashPolicy = bashPolicyFor(employee.supervision?.level);
    const bashApproval = bashPolicy.approval
      ? makeBashApproval({
          gate: checkGate(task.taskId),
          emit: (e) => bus.emit({ id: randomUUID(), ts: Date.now(), taskId: task.taskId, employeeId: employee.id, ...e }),
        })
      : undefined;

    // 任务计划（2026-09-05）：plan 模式走计划执行器逐项驱动（分流逻辑与 inproc executor 一致）
    if (task.plan) {
      return runTaskPlan({
        pkg: task as TaskPackage & { plan: PlanItem[] },
        employee,
        workspaceDir: wsDir,
        sessionsRoot: config.sessionsRoot,
        gateway: new ModelGateway([...config.routes, ...(config.employeeRoute ? [config.employeeRoute] : [])]),
        events: bus,
        checkGate,
        ...(agentFactory ? { agentFactory } : {}),
        // fork 快照语义（2026-09-05）：config.capabilities 为分派时刻快照（IPC JSON，fork 天生快照），
        // 包装为 provider 仅适配计划执行器签名——子进程内每项查表结果恒同，后台改动对后续分派生效
        capabilities: async () => config.capabilities ?? [],
        ...(config.forge ? { forge: config.forge } : {}),
        ...(config.deploy ? { deploy: config.deploy } : {}),
        ...(config.skills?.length ? { skills: config.skills } : {}),
        ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
        ...(config.retryPerItem !== undefined ? { retryPerItem: config.retryPerItem } : {}),
        ...(progress ? { progress } : {}),
        toolsForItem: (item, mcp, builtin) => defaultToolsFor(wsDir, {
          bashWhitelist: config.bashWhitelist,
          ...(config.bashTimeoutMs !== undefined ? { bashTimeoutMs: config.bashTimeoutMs } : {}),
          backend: makeBackend(config.backendKind, wsDir),
          ...(bashApproval ? { bashApproval } : {}),
          ...(bashPolicy.bypassWhitelist ? { bypassWhitelist: true } : {}),
          ...(config.forge ? { forge: config.forge, defaultRepo: repoPathFromUrl(task.repo.url) } : {}),
          ...(config.deploy ? { deploy: config.deploy } : {}),
          ...(workerMcpHub ? { mcpHub: workerMcpHub } : {}),
          ...(mcp.length ? { mcp } : { mcp: [] as string[] }),
          ...(builtin.length ? { builtin } : { builtin: [] as string[] }),
        }),
      });
    }

    const runtime = assembleDefaultRuntime({
      gateway: new ModelGateway([...config.routes, ...(config.employeeRoute ? [config.employeeRoute] : [])]),
      events: bus,
      tools: defaultToolsFor(wsDir, {
        bashWhitelist: config.bashWhitelist,
        ...(config.bashTimeoutMs !== undefined ? { bashTimeoutMs: config.bashTimeoutMs } : {}),
        backend: makeBackend(config.backendKind, wsDir),
        ...(bashApproval ? { bashApproval } : {}),
        ...(bashPolicy.bypassWhitelist ? { bypassWhitelist: true } : {}),
        ...(config.forge ? { forge: config.forge, defaultRepo: repoPathFromUrl(task.repo.url) } : {}),
      }),
      sessionsRoot: config.sessionsRoot,
      employee,
      taskId: task.taskId,
      checkGate,
      ...(agentFactory ? { agentFactory } : {}),
      ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
    });
    return runtime.runTaskPackage(task);
  }
}

/** fork 子进程直跑装配（T2 process-executor fork 本文件时启用） */
if (process.send) {
  runWorker({
    send: (msg) => process.send!(msg),
    onMessage: (handler) => process.on('message', handler),
  });
}
