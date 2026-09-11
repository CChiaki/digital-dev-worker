import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ControlledBash, EmployeeRoster, EventBus, ModelGateway,
  type EmployeeProfile, type ModelSpec, type RouteConfig, type TaskPackage,
} from '@ddw/runtime';
import type { TaskRecord, TaskStore, EventStore } from '../stores/types.js';
import { TeamScheduler } from './scheduler.js';
import type { SchedulerRoster } from './managed-roster.js';
import { createEmployeeExecutor, type EmployeeExecutor, type EmployeeExecutorOptions } from './executor.js';
import { CheckReviewQueue, gateForTask, listPendingChecks } from './review-gate.js';
import { makeBashApproval } from './bash-approval.js';
import { bashPolicyFor } from './supervision-policy.js';
import { defaultToolsFor, repoPathFromUrl, type BackendKind } from './default-tools.js';
import type { ForgeConfig, DeployConfig, StorageConfig, RetentionConfig } from './runtime-config.js';
import type { YanxunConfig } from './notifier.js';
import type { McpToolSource, McpServerConfig } from './mcp-hub.js';
import type { CapabilityDef } from './capabilities.js';
import type { SkillRecord } from './skill-store.js';
import { createProcessExecutor } from './process-executor.js';
import { clonePrepare } from './workspace-prepare.js';
import { sweepWorkspaces } from './retention.js';
import { log, errLine } from './logger.js';

export { defaultToolsFor };

/** 一体化运行时配置（startConsoleServer 的 runtime 可选项；T2 起由 yaml 解析产出） */
export interface ConsoleRuntimeOptions {
  /** 数字员工名册（id/name/role/skills/supervision）；2026-09-06 后台化后可选——
   *  装配层注入 roster（ManagedRoster）时不再传，仅独立使用/回退装配时提供 */
  profiles?: EmployeeProfile[];
  /** 调度 tick 间隔（默认 5s） */
  tickIntervalMs?: number;
  /** 员工工作区根：per-employee/task 隔离目录 */
  workspaceRoot: string;
  /** session 落盘根：per-employee 隔离 */
  sessionsRoot: string;
  /** 模型路由（chat/code/review/test，OpenAI 兼容私有集群） */
  routes: RouteConfig[];
  /** 控制台根地址（2026-09-06 可选）：通知渠道推送时拼任务直达链接 `${consoleUrl}/tasks/:taskId` */
  consoleUrl?: string;
  /** bash 白名单（首 token，ControlledBash 软防线）；默认编码常用集。
   *  白名单外命令按盯梢等级放权（2026-09-11 三级重构）：shadow/assisted 挂审、trusted 直接执行 */
  bashWhitelist?: string[];
  /** 受控 bash 单条命令超时毫秒（缺省 60s）：构建类命令（pnpm install/build）按需放大 */
  bashTimeoutMs?: number;
  /** 每任务最大对话轮数（2026-09-10 yaml 可配，缺省 EmployeeRuntime 内置 40）：
   *  达到上限任务以 max_turns 终态优雅退出 */
  maxTurns?: number;
  /** 计划模式每项失败自动重试次数（2026-09-11 P2 产品批 yaml 可配，缺省 0 = 失败即停）：
   *  inproc 透传执行器 / fork 随 config 快照下发 worker */
  retryPerItem?: number;
  /** 执行层硬防线（spec 4.7）：默认 Noop 直跑；试点机换 Bwrap、生产换 Docker */
  bashBackend?: ConstructorParameters<typeof ControlledBash>[0]['backend'];
  /** 执行模式（P13）：inproc 单进程（默认）| fork 每任务独立子进程（崩溃隔离 + 事件 IPC 回流） */
  execMode?: 'inproc' | 'fork';
  /** fork 模式的硬防线 backend 类型字面量（IPC 只能带 JSON，实例不可传输）；缺省 noop */
  backendKind?: BackendKind;
  /** fork 模式 agent 工厂模块路径（e2e/测试注入 faux；生产 pi 直连不传） */
  agentModulePath?: string;
  /** 代码托管协作（可选）：配置后员工工具集注入 建分支/提交/建 MR 工具（provider: gitlab/gitea） */
  forge?: ForgeConfig;
  /** 发布部署配置（2026-09-05 计划模式 devops 项；由 runtime yaml deploy 段解析传入） */
  deploy?: DeployConfig;
  /** 标准 MCP 工具源（2026-09-06 用户需求 B）：inproc 直传 hub；fork 快照 mcpServers 由 process-executor 下发 */
  mcpHub?: McpToolSource;
  /** 存储配置（存储企业化 Task 7）：由 runtime yaml storage 段透传，装配层据此构造唯一 SqlDriver；
   *  缺省 = DEFAULT_STORAGE（sqlite）。调度器本身不感知存储实现 */
  storage?: StorageConfig;
  /** MCP server 配置快照（fork 模式下发 worker 子进程自建 hub；hub 实例无法走 IPC） */
  mcpServers?: McpServerConfig[];
  /** 内部燕讯通知接入（2026-09-10，由 runtime yaml yanxun 段解析传入）：调度器不消费——
   *  装配层 server.ts 读取并接进消息渠道推送（pushToChannel/sendTestMessage） */
  yanxun?: YanxunConfig;
  /** API 鉴权（2026-09-11 P0 安全批，由 runtime yaml auth 段解析传入）：调度器不消费——
   *  server.ts 构造 ApiGuard（Bearer/query token → operator 注入）；缺省 = 鉴权关闭 */
  auth?: { tokens: { name: string; token: string }[] };
  /** 监听地址绑定（2026-09-11）：调度器不消费——server.listen 第二参；缺省全网卡现状 */
  bindHost?: string;
  /** 安全 strict 模式（2026-09-11 用户复盘批）：调度器不消费——server.ts 启动前置检查
   *  （未配 auth/bindHost 拒绝启动）；缺省 false = 仅 ERROR 横幅 */
  strictMode?: boolean;
  /** 任务级 wall-clock 看门狗（2026-09-11 P0 韧性批，yaml taskTimeoutMs）：
   *  running 超时 → failed「任务超时」+ 释放员工（挂审 4 倍宽限）。缺省 = 关闭 */
  taskTimeoutMs?: number;
  /** 磁盘治理（2026-09-11 P1 治理批，yaml retention 段）：done/failed 任务 workspace/session
   *  目录 mtime TTL 清扫（小时级巡检，随 server `...opts.runtime` spread 透传）。缺省 = 关闭 */
  retention?: RetentionConfig;
  /** 能力定义提供者（2026-09-05 计划模式 per-item 工具集；后台可改，分派时取最新） */
  capabilities?: () => Promise<CapabilityDef[]>;
  /** Skill 注入（2026-09-06）：按员工 id 实时取 approved 清单；inproc 每任务执行前取，fork 分派时取快照；
   *  多岗位（2026-09-07）：第二参为任务岗位——命中员工集合只注入该岗位 skill，缺省全岗位并集 */
  skillsFor?: (employeeId: string, taskRole?: string) => Promise<SkillRecord[]>;
  /** gateway/executor 测试注入（faux e2e）；缺省生产组装 ModelGateway(routes)。fork 模式忽略 gateway */
  gateway?: EmployeeExecutorOptions['gateway'];
  executor?: EmployeeExecutor;
  /** 复核队列注入（e2e：与 HTTP handle 共享同一 queue）；缺省新建 */
  reviewQueue?: CheckReviewQueue;
  /** 员工名册注入（2026-09-06 后台化）：ManagedRoster（EmployeeStore 为事实源）等；
   *  缺省回退 runtime EmployeeRoster(profiles) */
  roster?: SchedulerRoster;
  /** 分派前谓词（2026-09-06）：如员工能力绑定过滤；返回 false 该员工跳过（任务留池 waiting） */
  canDispatch?: (task: TaskRecord, employee: EmployeeProfile) => boolean;
  /** 每 tick 前调用（2026-09-06）：如 ManagedRoster.refresh()——后台档案改动下个 tick 生效 */
  onBeforeTick?: () => Promise<void>;
  /** 员工专属模型（2026-09-06 一人一模型一 key）：inproc executor 直接注入；
   *  fork 链路经 process-executor 转 employeeRoute 随 job 下发 */
  modelFor?: (employeeId: string) => ModelSpec | undefined;
  /** 任务成功完成回调（2026-09-06 蒸馏钩子）：透传给调度器（仅 ok=true 触发） */
  onTaskComplete?: (task: TaskPackage, employee: EmployeeProfile) => Promise<void> | void;
  onTickError?: (e: unknown) => void;
}

export interface RuntimePipeline {
  scheduler: TeamScheduler;
  /** 人工复核队列（P10）：HTTP review 调用其 review() 唤醒阻塞中的 task_check */
  reviewQueue: CheckReviewQueue;
  /** 启动定时 tick（默认 5s，一次性） */
  start(): void;
  stop(): void;
}

/** 生产缺省工具集：工作区编码工具 + 受控 bash（白名单 + 硬防线可配）；P13 起统一收口 default-tools.ts */
export type { BackendKind } from './default-tools.js';

/**
 * 一体化运行时装配（P9-T1）：任务池 + 事件流 + 名册 + 执行器 → 调度器。
 * 纯组装、无副作用（不起定时器不监听端口），start() 由 startConsoleServer 调用；
 * 测试注入 faux executor / gateway 手动 tick。
 */
export function createRuntimePipeline(
  deps: { tasks: TaskStore; events: EventStore },
  opts: ConsoleRuntimeOptions,
): RuntimePipeline {
  const bus = new EventBus();
  bus.addSink({ write: (e) => deps.events.append(e) }); // 员工事件/调度事件同源落库（hash 链保序）
  const reviewQueue = opts.reviewQueue ?? new CheckReviewQueue();
  const gateway = opts.gateway ?? new ModelGateway(opts.routes);
  // fork 模式（P13）：executor 显式注入优先（e2e 共享装配）；否则每任务 fork worker 子进程，
  // 事件经 IPC 回流主进程统一 append（hash 链保序不变），闸门桥接同一 reviewQueue
  const executor = opts.executor
    ?? (opts.execMode === 'fork'
      ? createProcessExecutor({
          events: deps.events,
          reviewQueue,
          config: {
            routes: opts.routes,
            backendKind: opts.backendKind ?? 'noop',
            workspaceRoot: opts.workspaceRoot,
            sessionsRoot: opts.sessionsRoot,
            ...(opts.bashWhitelist !== undefined ? { bashWhitelist: opts.bashWhitelist } : {}),
            ...(opts.bashTimeoutMs !== undefined ? { bashTimeoutMs: opts.bashTimeoutMs } : {}),
            ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
            ...(opts.retryPerItem !== undefined ? { retryPerItem: opts.retryPerItem } : {}),
            ...(opts.agentModulePath ? { agentModulePath: opts.agentModulePath } : {}),
            // faux agent 注入（e2e/测试）无真实仓库 → 跳过 clone（生产不传 agentModulePath，恒 clone）
            ...(opts.agentModulePath ? { skipWorkspacePrepare: true } : {}),
            ...(opts.forge ? { forge: opts.forge } : {}),
            ...(opts.deploy ? { deploy: opts.deploy } : {}),
            // fork 模式：hub 实例不可走 IPC，下发 server 配置快照，worker 子进程自建（语义=分派时刻快照）
            ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
          },
          // 能力定义 provider：process-executor 在分派时刻取快照随 job 下发
          ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
          // Skill 注入（2026-09-06）：process-executor 分派时刻取快照随 job 下发
          ...(opts.skillsFor ? { skillsFor: opts.skillsFor } : {}),
          // 员工专属模型（2026-09-06 一人一模型一 key）：分派时刻解析转 employeeRoute 下发
          ...(opts.modelFor ? { modelFor: opts.modelFor } : {}),
          // fork 任务超时（2026-09-11 P0 韧性批）：到点 kill 子进程（TERM→KILL），与主进程
          // 看门狗双保险——DB 收割先到则子进程结果迟到被丢弃，子进程 kill 先到则 crashOutcome 正常回写；
          // 挂审宽限探针与主进程同源（listPendingChecks 事件流推导）
          ...(opts.taskTimeoutMs ? {
            taskTimeoutMs: opts.taskTimeoutMs,
            extendTimeoutIf: async (taskId: string) =>
              (await listPendingChecks(deps.events, deps.tasks)).some((c) => c.taskId === taskId),
          } : {}),
        })
      : createEmployeeExecutor({
          workspaceRoot: opts.workspaceRoot,
          sessionsRoot: opts.sessionsRoot,
          gateway,
          events: bus,
          // shadow 级员工 task_check 申报后阻塞等人工放行（P10 盯梢闭环）
          checkGate: (taskId) => gateForTask(reviewQueue, taskId),
          // 任务工作区 clone（2026-09-06 实战修复）：执行前按 repo.url 拉代码，空目录 git 穿透教训
          prepareWorkspace: clonePrepare(opts.forge),
          bashWhitelist: opts.bashWhitelist,
          ...(opts.bashTimeoutMs !== undefined ? { bashTimeoutMs: opts.bashTimeoutMs } : {}),
          ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
          ...(opts.retryPerItem !== undefined ? { retryPerItem: opts.retryPerItem } : {}),
          ...(opts.bashBackend ? { backend: opts.bashBackend } : {}),
          forge: opts.forge,
          deploy: opts.deploy,
          ...(opts.mcpHub ? { mcpHub: opts.mcpHub } : {}),
          capabilities: opts.capabilities,
          // Skill 注入（2026-09-06）：inproc 每任务执行前实时取 approved 清单（executor 闭包内消费）
          ...(opts.skillsFor ? { skillsFor: opts.skillsFor } : {}),
          // 员工专属模型（2026-09-06 一人一模型一 key）：执行闭包内解析为专属 gateway
          ...(opts.modelFor ? { modelFor: opts.modelFor } : {}),
          toolsFor: (task, employee) => {
            const wsDir = join(opts.workspaceRoot, employee.id, task.taskId.replaceAll('/', '_'));
            // 白名单外命令人工放行（非计划路径，2026-09-11 盯梢三级改等级驱动）：
            // shadow/assisted 挂审（闸门同源 reviewQueue），trusted 由策略 bypass 白名单直接执行
            const bashPolicy = bashPolicyFor(employee.supervision?.level);
            const bashApproval = bashPolicy.approval
              ? makeBashApproval({
                  gate: gateForTask(reviewQueue, task.taskId),
                  emit: (e) => bus.emit({ id: randomUUID(), ts: Date.now(), taskId: task.taskId, employeeId: employee.id, ...e }),
                })
              : undefined;
            return defaultToolsFor(wsDir, {
              bashWhitelist: opts.bashWhitelist,
              ...(opts.bashTimeoutMs !== undefined ? { bashTimeoutMs: opts.bashTimeoutMs } : {}),
              ...(opts.bashBackend ? { backend: opts.bashBackend } : {}),
              ...(bashApproval ? { bashApproval } : {}),
              ...(bashPolicy.bypassWhitelist ? { bypassWhitelist: true } : {}),
              // forge 配置时注入协作工具；默认仓库由任务包 repo.url 推导
              ...(opts.forge ? { forge: opts.forge, defaultRepo: repoPathFromUrl(task.repo.url) } : {}),
            });
          },
        }));
  const scheduler = new TeamScheduler({
    tasks: deps.tasks,
    events: deps.events,
    // 2026-09-06 后台化：装配层注入 ManagedRoster（EmployeeStore 事实源）；
    // 缺省回退 yaml profiles 名册（零回归）
    roster: opts.roster ?? new EmployeeRoster(opts.profiles ?? []),
    ...(opts.canDispatch ? { canDispatch: opts.canDispatch } : {}),
    // 蒸馏沉淀钩子（2026-09-06）：任务成功完成后异步蒸馏候选 Skill（由 server 接线注入）
    ...(opts.onTaskComplete ? { onTaskComplete: opts.onTaskComplete } : {}),
    executor,
    // 生产语义：tick 只分派不等完成——shadow 级人工放行阻塞 runOne 时不得拖死新任务分派
    awaitCompletion: false,
    // 任务看门狗（2026-09-11 P0 韧性批）：超时收割 + 挂审 4 倍宽限（待审由事件流推导）
    ...(opts.taskTimeoutMs ? { taskTimeoutMs: opts.taskTimeoutMs } : {}),
    ...(opts.taskTimeoutMs ? { pendingChecksOf: () => listPendingChecks(deps.events, deps.tasks) } : {}),
  });

  // 每 tick 前钩子（2026-09-06）：如 ManagedRoster.refresh()——后台档案改动下个 tick 生效；
  // 启动即试一轮同样先过钩子，两条触发路径语义一致
  const tickOnce = () =>
    Promise.resolve(opts.onBeforeTick?.())
      .then(() => scheduler.tick())
      .catch(opts.onTickError ?? ((e) => log.error('runtime', 'tick 失败:', e)));

  let timer: ReturnType<typeof setInterval> | undefined;
  // 看门狗巡检定时器（2026-09-11 P0 韧性批）：30s 一轮独立于 tick（不占分派节奏），
  // 与 tick 串行化在 scheduler 内部保证（watchdogSweep await this.tail）
  let watchdog: ReturnType<typeof setInterval> | undefined;
  // 磁盘治理定时器（2026-09-11 P1 治理批）：小时级低频清扫 done/failed 任务 workspace/session；
  // 启动即先试一轮（重启间隙可能积压超期目录）
  let sweeper: ReturnType<typeof setInterval> | undefined;
  const sweepOnce = (): void => {
    sweepWorkspaces({ workspaceRoot: opts.workspaceRoot, sessionsRoot: opts.sessionsRoot }, opts.retention?.workspaceDays ?? 0)
      .then((removed) => {
        if (removed.length > 0) log.info('retention', `磁盘清扫：${removed.length} 个超期任务目录已删除（${removed.slice(0, 5).join(', ')}${removed.length > 5 ? '…' : ''}）`);
      })
      .catch((e) => log.error('retention', '磁盘清扫失败:', errLine(e)));
  };
  return {
    scheduler,
    reviewQueue,
    start() {
      if (timer) return; // 幂等
      timer = setInterval(() => {
        void tickOnce();
      }, opts.tickIntervalMs ?? 5_000);
      // 重启去重播种（2026-09-11 用户复盘批）：先回放 blocked/waiting 留痕进缓存再跑首轮
      // tick——状态未变的任务不再重复留痕（seedNotes 内部吞错，失败退化为现状）
      void scheduler.seedNotes().finally(() => { void tickOnce(); });
      if (opts.taskTimeoutMs) {
        watchdog = setInterval(() => {
          void scheduler.watchdogSweep().catch((e) =>
            log.error('runtime', '看门狗巡检失败:', errLine(e)));
        }, 30_000);
      }
      if ((opts.retention?.workspaceDays ?? 0) > 0) {
        sweepOnce(); // 启动即先试一轮
        sweeper = setInterval(sweepOnce, 3_600_000); // 每小时
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (watchdog) clearInterval(watchdog);
      watchdog = undefined;
      if (sweeper) clearInterval(sweeper);
      sweeper = undefined;
    },
  };
}
