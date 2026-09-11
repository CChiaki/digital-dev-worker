import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  EmployeeRuntime, EmployeeSessionStore, ModelGateway,
  type AgentFactory, type CheckGate, type EventBus, type EmployeeOutcome, type PlanItem,
  type PlanProgress, type SandboxBackend, type TaskPackage, type ToolRegistry,
  type EmployeeProfile, type ModelSpec,
} from '@ddw/runtime';
import { runTaskPlan } from './plan-runner.js';
import { defaultToolsFor, repoPathFromUrl, type McpToolSource } from './default-tools.js';
import { makeBashApproval } from './bash-approval.js';
import { bashPolicyFor } from './supervision-policy.js';
import type { SkillRecord } from './skill-store.js';
import type { CapabilityDef } from './capabilities.js';
import type { DeployConfig, ForgeConfig } from './runtime-config.js';

/** 员工执行器：调度器分派后的执行拉起（输入任务 + 员工档案，产出执行结果） */
export type EmployeeExecutor = (input: {
  task: TaskPackage;
  employee: EmployeeProfile;
  /** 计划续跑：已有个项进度（done 项跳过，从停点续） */
  progress?: PlanProgress[];
}) => Promise<EmployeeOutcome>;

export interface EmployeeExecutorOptions {
  /** 员工工作区根：每个员工 <root>/<employeeId>/<taskId> 隔离目录 */
  workspaceRoot: string;
  /** session 落盘根：按员工隔离 <root>/<employeeId> */
  sessionsRoot: string;
  gateway: ModelGateway;
  events: EventBus;
  /** 员工级工具组装（编码工具/bash + 远端协作 MCP，workspace 沙箱内） */
  toolsFor: (task: TaskPackage, employee: EmployeeProfile) => Promise<ToolRegistry> | ToolRegistry;
  /** 工作区预置钩子（如 git init + 初始代码落盘）；缺省空目录 */
  prepareWorkspace?: (dir: string, task: TaskPackage, employee: EmployeeProfile) => Promise<void>;
  /** runtime 工厂（测试注入 stub 记录入参；生产缺省原样返回） */
  runtimeFactory?: (runtime: EmployeeRuntime) => EmployeeRuntime;
  /** 人工放行闸门（P10 盯梢闭环）：默认组装时仅 shadow 级员工注入——task_check 申报后阻塞等人工放行 */
  checkGate?: (taskId: string) => CheckGate;
  /** 完全自定义 runtime 构造（e2e/特殊场景：定制 agentFactory 等）；提供时优先于默认组装 */
  runtimeFor?: (input: {
    task: TaskPackage;
    employee: EmployeeProfile;
    workspaceDir: string;
    tools: ToolRegistry;
  }) => Promise<EmployeeRuntime> | EmployeeRuntime;
  /** 能力定义提供者（计划模式 per-item 工具集；后台可改，分派时取最新） */
  capabilities?: () => Promise<CapabilityDef[]>;
  /** 发布部署配置（devops 项） */
  deploy?: DeployConfig;
  /** 代码托管协作配置（commit 项；存在性校验 + forge 工具注入） */
  forge?: ForgeConfig;
  /** bash 白名单（首 token，ControlledBash 软防线）；计划模式 per-item 工具集组装用 */
  bashWhitelist?: string[];
  /** 受控 bash 单条命令超时毫秒（缺省 60s）：构建类命令按需放大；计划模式 per-item 工具集组装用 */
  bashTimeoutMs?: number;
  /** 每任务最大对话轮数（2026-09-10 yaml 可配；缺省 EmployeeRuntime 内置 40）：
   *  达到上限任务以 max_turns 终态优雅退出 */
  maxTurns?: number;
  /** 计划模式每项失败自动重试次数（2026-09-11 P2 产品批；缺省 0 = 失败即停保持现状） */
  retryPerItem?: number;
  /** 执行层硬防线 backend（spec 4.7）；计划模式 per-item 工具集组装用——试点机配了
   *  bwrap/docker 时 plan 任务同样沙箱直跑（不静默退回 Noop）。缺省 Noop 行为零变化。 */
  backend?: SandboxBackend;
  /** 标准 MCP 工具源（2026-09-06 用户需求 B）：能力 tools.mcp 中的 server 名从此取已发现工具 */
  mcpHub?: McpToolSource;
  /** 员工专属模型绑定（2026-09-06 增补：一人一模型一 key）：返回该员工 ModelSpec 时
   *  本次执行改用专属 gateway；缺省/未绑定 = 全局 gateway 零回归 */
  modelFor?: (employeeId: string) => ModelSpec | undefined;
  /** Skill 注入（2026-09-06）：按员工 id 实时取 approved 清单（后台改判/新入库下个任务即生效）；
   *  多岗位（2026-09-07）：第二参为任务岗位——命中员工集合只注入该岗位 skill，缺省全岗位并集 */
  skillsFor?: (employeeId: string, taskRole?: string) => Promise<SkillRecord[]>;
}

/** 专属 gateway 解析（纯函数可测）：绑定存在 → 单 code 路由覆盖（EmployeeRuntime 缺省 callType='code'，
 *  专属模型即执行模型——2026-09-10 修复：此前误用 chat 路由，绑定后 modelFor('code') 直接抛
 *  「未配置的调用类型: code」，专属模型反而跑不起来）；未绑定 = 原样复用全局 gateway 零回归 */
export function resolveExecutorGateway(base: ModelGateway, bound?: ModelSpec): ModelGateway {
  return bound ? new ModelGateway([{ callType: 'code', primary: bound }]) : base;
}

/**
 * 默认 runtime 组装（P13-T1 抽取共用）：in-process executor 与 fork worker 同一处实现——
 * shadow 级闸门判断（仅 shadow 注入 checkGate）+ per-employee session 隔离 + supervision 注入。
 */
export function assembleDefaultRuntime(input: {
  gateway: ModelGateway;
  events: EventBus;
  tools: ToolRegistry;
  sessionsRoot: string;
  employee: EmployeeProfile;
  taskId: string;
  checkGate?: (taskId: string) => CheckGate;
  /** agent 工厂注入（测试 faux / fork worker 注入自定义模块）；缺省生产 pi 直连 */
  agentFactory?: AgentFactory;
  /** 每任务最大对话轮数（yaml maxTurns；缺省 EmployeeRuntime 内置 40） */
  maxTurns?: number;
}): EmployeeRuntime {
  // shadow 级盯梢：task_check 申报后阻塞等人工放行（assisted/trusted 不阻塞，照旧留痕）
  const gate = input.checkGate && input.employee.supervision?.level === 'shadow'
    ? input.checkGate(input.taskId)
    : undefined;
  return new EmployeeRuntime({
    gateway: input.gateway,
    tools: input.tools,
    interceptors: [],
    events: input.events,
    sessions: new EmployeeSessionStore(join(input.sessionsRoot, input.employee.id)),
    config: {
      employeeId: input.employee.id,
      supervision: input.employee.supervision,
      ...(gate ? { checkGate: gate } : {}),
      ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    },
    ...(input.agentFactory ? { agentFactory: input.agentFactory } : {}),
  });
}

/**
 * 组装员工执行器（P8 班组并行，D2 单进程多 runtime）：
 * per-employee 隔离 workspace/session，supervision 随档案注入，
 * 执行序 = runtime.runTaskPackage（接单→编码→…→汇报 SOP 不变）。
 */
export function createEmployeeExecutor(opts: EmployeeExecutorOptions): EmployeeExecutor {
  const newRuntime = opts.runtimeFactory ?? ((r) => r);
  return async ({ task, employee, progress }) => {
    // 员工专属模型（2026-09-06 一人一模型一 key）：有绑定 → 单 chat 路由专属 gateway，缺省全局零回归
    const gateway = resolveExecutorGateway(opts.gateway, opts.modelFor?.(employee.id));
    const wsDir = join(opts.workspaceRoot, employee.id, task.taskId.replaceAll('/', '_'));
    // 从零执行（progress 缺省）先清该任务的 workspace 与 session 残留（2026-09-06）：
    // 重跑同名任务不接上一轮的产物文件与会话上下文；断点续跑（progress 在场）保留一切——
    // resumeWith 依赖同会话延续与既有产物
    if (!progress) {
      await rm(wsDir, { recursive: true, force: true });
      await new EmployeeSessionStore(join(opts.sessionsRoot, employee.id)).remove(task.taskId);
    }
    await mkdir(wsDir, { recursive: true });
    await opts.prepareWorkspace?.(wsDir, task, employee);

    // 白名单外命令人工放行（2026-09-11 盯梢三级重构：等级驱动）：shadow/assisted 挂审
    // （per-task 记忆闭包，同命令名放行过即记住），trusted 由 bashPolicyFor 判定不构造
    // （bypassWhitelist 走 defaultToolsFor）；审批人在人工放行页看到命令原文
    const bashPolicy = bashPolicyFor(employee.supervision?.level);
    const bashApproval = bashPolicy.approval && opts.checkGate
      ? makeBashApproval({
          gate: opts.checkGate(task.taskId),
          emit: (e) => opts.events.emit({ id: randomUUID(), ts: Date.now(), taskId: task.taskId, employeeId: employee.id, ...e }),
        })
      : undefined;

    // 任务计划（2026-09-05）：plan 模式走计划执行器逐项驱动（kind→工具集/verify 客观门禁/失败即停）
    if (task.plan) {
      return runTaskPlan({
        pkg: task as TaskPackage & { plan: PlanItem[] },
        employee,
        workspaceDir: wsDir,
        sessionsRoot: opts.sessionsRoot,
        gateway,
        events: opts.events,
        ...(opts.checkGate ? { checkGate: opts.checkGate } : {}),
        // provider 直传：每项执行前重新查注册表（spec §5 运行中被改语义，inproc 即时生效）
        capabilities: opts.capabilities ?? (async () => []),
        ...(opts.deploy ? { deploy: opts.deploy } : {}),
        ...(opts.forge ? { forge: opts.forge } : {}),
        ...(progress ? { progress } : {}),
        // 多岗位（2026-09-07）：按任务岗位过滤注入——命中单岗精准，缺省/不在集合并集兜底
        ...(opts.skillsFor ? { skills: await opts.skillsFor(employee.id, task.role) } : {}),
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        ...(opts.retryPerItem !== undefined ? { retryPerItem: opts.retryPerItem } : {}),
        toolsForItem: (item, mcp, builtin) => defaultToolsFor(wsDir, {
          bashWhitelist: opts.bashWhitelist,
          ...(opts.bashTimeoutMs !== undefined ? { bashTimeoutMs: opts.bashTimeoutMs } : {}),
          ...(opts.backend ? { backend: opts.backend } : {}),
          ...(bashApproval ? { bashApproval } : {}),
          ...(bashPolicy.bypassWhitelist ? { bypassWhitelist: true } : {}),
          ...(opts.forge ? { forge: opts.forge, defaultRepo: repoPathFromUrl(task.repo.url) } : {}),
          ...(opts.deploy ? { deploy: opts.deploy } : {}),
          ...(opts.mcpHub ? { mcpHub: opts.mcpHub } : {}),
          ...(mcp.length ? { mcp } : { mcp: [] as string[] }),
          ...(builtin.length ? { builtin } : { builtin: [] as string[] }),
        }),
      });
    }

    const tools = await opts.toolsFor(task, employee);
    const runtime = opts.runtimeFor
      ? await opts.runtimeFor({ task, employee, workspaceDir: wsDir, tools })
      : newRuntime(assembleDefaultRuntime({
          gateway,
          events: opts.events,
          tools,
          sessionsRoot: opts.sessionsRoot,
          employee,
          taskId: task.taskId,
          ...(opts.checkGate ? { checkGate: opts.checkGate } : {}),
          ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        }));
    return runtime.runTaskPackage(task);
  };
}
