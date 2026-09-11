import { fork } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EmployeeOutcome, EmployeeProfile, ModelSpec, PlanProgress, TaskPackage } from '@ddw/runtime';
import type { EventStore } from '../stores/types.js';
import type { EmployeeExecutor } from './executor.js';
import { CheckReviewQueue } from './review-gate.js';
import type { CapabilityDef } from './capabilities.js';
import type { SkillRecord } from './skill-store.js';
import type { MainToWorker, WorkerJob, WorkerToMain } from './worker.js';

/**
 * 进程执行器（P13-T2）：每任务 fork 一个 worker 子进程跑完即退——
 * 崩溃隔离（员工进程崩不拖死控制台）、CPU/IO 密集执行不影响 API 响应。
 * worker 的事件经 IPC 回流主进程统一 append（hash 链保序 = 主进程到达序，
 * worker 不直接写 store，杜绝跨进程并发写）；shadow 闸门经 gate-wait/gate-verdict
 * 桥接主进程 CheckReviewQueue（P10 语义跨进程不变）。
 *
 * 失败语义（保守，与 P8 失败传播一致）：worker 报 error / 非零退出 / IPC 断连 →
 * outcome `{status:'max_turns', reply:'执行进程异常退出: …', turns:0}` → 调度器 ok=false →
 * 任务 failed、下游 blocked。
 */

export interface ProcessExecutorOptions {
  /** 任务级配置（routes/bashWhitelist/bashTimeoutMs/backendKind/workspaceRoot/sessionsRoot/agentModulePath），随 job 下发 */
  config: WorkerJob['config'];
  /** 事件统一落库（主进程侧；EventStore append 即 hash 链保序） */
  events: EventStore;
  /** 人工复核队列：gate-wait 桥接到它，review() 唤醒后 verdict 回传 worker */
  reviewQueue: CheckReviewQueue;
  /** worker 入口脚本路径（fork 目标）；缺省本目录 worker.ts */
  workerPath?: string;
  /** fork 的 node execArgv；默认清空（vitest 注入的 loader 钩子不应传染 worker） */
  execArgv?: string[];
  /** worker 异常观测钩子（测试/告警用） */
  onWorkerError?: (message: string) => void;
  /** 能力定义提供者（计划模式）：分派时刻取快照随 job 下发（后台改动对后续分派生效） */
  capabilities?: () => Promise<CapabilityDef[]>;
  /** Skill 注入（2026-09-06 fork）：分派时刻按员工分类取 approved 快照随 job 下发；
   *  多岗位（2026-09-07）：第二参为任务岗位（分派时刻快照同样按任务岗位预过滤） */
  skillsFor?: (employeeId: string, taskRole?: string) => Promise<SkillRecord[]>;
  /** 员工专属模型绑定（2026-09-06 一人一模型一 key）：返回 ModelSpec 时随 job 下发
   *  employeeRoute（worker 侧尾部覆盖全局 code 路由——执行模型即专属模型，2026-09-10 修复：
   *  此前误用 chat 路由，EmployeeRuntime 缺省 callType='code' 取不到绑定反而静默用全局）；缺省/未绑定 = 全局零回归 */
  modelFor?: (employeeId: string) => ModelSpec | undefined;
  /** 任务级超时（2026-09-11 P0 韧性批）：到点 kill 子进程（SIGTERM → 5s 宽限 → SIGKILL），
   *  结局走 crashOutcome「任务超时」；与主进程看门狗（DB 收割）双保险，先到者生效 */
  taskTimeoutMs?: number;
  /** 挂审宽限探针（2026-09-11）：超时到点回调——返回 true = 该任务挂审待放行中，
   *  重臂一轮超时再等（与主进程看门狗 4 倍宽限语义对齐） */
  extendTimeoutIf?: (taskId: string) => Promise<boolean>;
}

/** 崩溃/报错的保守 outcome（turns 0——调度器据 ok=false 传播 failed/blocked） */
function crashOutcome(reason: string): EmployeeOutcome {
  return { status: 'max_turns', reply: `执行进程异常退出: ${reason}`, turns: 0 };
}

export function createProcessExecutor(opts: ProcessExecutorOptions): EmployeeExecutor {
  const workerPath = opts.workerPath ?? fileURLToPath(new URL('./worker.ts', import.meta.url));
  // 默认挂 .js→.ts 解析钩子：本仓库 TS 源码为 NodeNext 风格 .js 后缀导入，
  // 裸 node 类型剥离不重写后缀，worker 直跑 TS 必须靠钩子解析（vitest/vite 不经过此路径）
  const tsRegister = fileURLToPath(new URL('./ts-register.mjs', import.meta.url));
  const execArgv = opts.execArgv ?? ['--import', tsRegister];

  return async ({ task, employee, progress }: { task: TaskPackage; employee: EmployeeProfile; progress?: PlanProgress[] }): Promise<EmployeeOutcome> => {
    // worker stdout/stderr 按任务归集（2026-09-11 P2 产品批）：fork 模式原 stdio inherit——
    // 多任务并发时输出混流无法定位；改 pipe → tee 到任务工作区 worker.log（随 retention TTL 清理）
    // 并原样转发主进程（pm2 日志仍可见全量）。worker 无输出场景（正常执行）不受影响
    const taskDir = join(opts.config.workspaceRoot, employee.id, task.taskId.replaceAll('/', '_'));
    await mkdir(taskDir, { recursive: true });
    const workerLog = createWriteStream(join(taskDir, 'worker.log'), { flags: 'a' });
    const child = fork(workerPath, { execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const tee = (stream: import('node:stream').Readable | null, errors: boolean): void => {
      stream?.on('data', (chunk: Buffer) => {
        workerLog.write(chunk);
        (errors ? process.stderr : process.stdout).write(`[ddw:worker ${task.taskId}] `.concat(chunk.toString()));
      });
    };
    tee(child.stdout, false);
    tee(child.stderr, true);
    child.on('close', () => workerLog.end()); // close 在 stdio 流排空后触发（比 exit 晚，恰好）
    // fork 快照语义（2026-09-05 计划模式）：capabilities 在分派时刻取快照随 job 下发；
    // 员工专属模型（2026-09-06 一人一模型一 key）同样分派时刻解析随 job 下发
    const bound = opts.modelFor?.(employee.id);
    const config: WorkerJob['config'] = {
      ...opts.config,
      ...(bound ? { employeeRoute: { callType: 'code' as const, primary: bound } } : {}),
      ...(opts.capabilities ? { capabilities: await opts.capabilities() } : {}),
      // 多岗位（2026-09-07）：分派快照同样按任务岗位预过滤——命中单岗精准，缺省/不在集合并集兜底
      ...(opts.skillsFor ? { skills: await opts.skillsFor(employee.id, task.role) } : {}),
    };
    const job: WorkerJob = { task, employee, config, ...(progress ? { progress } : {}) };
    try {
      return await new Promise<EmployeeOutcome>((resolve, reject) => {
        let settled = false;
        const settle = (outcome: EmployeeOutcome) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };
        const fail = (reason: string) => {
          if (settled) return;
          settled = true;
          reject(new Error(reason));
        };
        // 任务超时（2026-09-11 P0 韧性批）：TERM → 5s 宽限 → KILL；正常 exit/error/done 先落定则超时路径作废。
        // 挂审宽限：到点先问主进程该任务是否挂审待放行（extendTimeoutIf），是则重臂一轮再等——
        // 与主进程看门狗的 4 倍宽限语义对齐（等人工不是 hang）
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let killGrace: ReturnType<typeof setTimeout> | undefined;
        const clearKill = (): void => {
          if (killTimer) clearTimeout(killTimer);
          if (killGrace) clearTimeout(killGrace);
          killTimer = undefined;
          killGrace = undefined;
        };
        if (opts.taskTimeoutMs) {
          const armTimeout = (): void => {
            killTimer = setTimeout(() => {
              if (settled) return;
              void Promise.resolve(opts.extendTimeoutIf?.(task.taskId) ?? Promise.resolve(false))
                .catch(() => false)
                .then((extended) => {
                  if (settled) return;
                  if (extended) { armTimeout(); return; }
                  child.kill('SIGTERM');
                  killGrace = setTimeout(() => child.kill('SIGKILL'), 5_000);
                });
            }, opts.taskTimeoutMs);
          };
          armTimeout();
        }

        child.on('message', (msg: WorkerToMain) => {
          if (msg.type === 'event') {
            // 事件回流主进程统一落库（worker 不写 store——hash 链保序 = 主进程到达序）
            void opts.events.append(msg.event);
            return;
          }
          if (msg.type === 'gate-wait') {
            // 闸门跨进程：挂到主进程复核队列，人工 review() 后 verdict 回传 worker
            void opts.reviewQueue.wait(msg.check.taskId, { item: msg.check.item, result: msg.check.result, passed: msg.check.passed })
              .then((verdict) => {
                if (!child.connected) return; // worker 已退出：待审由事件流推导侧清理，verdict 无处可去
                child.send({ type: 'gate-verdict', requestId: msg.requestId, verdict } satisfies MainToWorker);
              });
            return;
          }
          if (msg.type === 'done') {
            clearKill();
            settle(msg.outcome);
            return;
          }
          // error：worker 内组装/执行失败（如坏 agent 模块）——保守 failed
          opts.onWorkerError?.(msg.message);
          clearKill();
          settle(crashOutcome(msg.message));
        });
        child.on('error', (err) => { clearKill(); fail(`执行进程拉起失败: ${err.message}`); });
        child.on('exit', (code, signal) => {
          if (settled) return;
          clearKill();
          opts.onWorkerError?.(`exit code=${code} signal=${signal}`);
          // 超时 kill 触发的退出（TERM/KILL 信号）单独话术，便于运维定位看门狗行为
          const limit = opts.taskTimeoutMs;
          const timedOut = limit !== undefined && (signal === 'SIGTERM' || signal === 'SIGKILL');
          settle(crashOutcome(timedOut ? `任务超时（${Math.round(limit / 1000)}s，kill signal=${signal}）` : `exit code=${code} signal=${signal}`));
        });

        child.send({ type: 'job', job } satisfies MainToWorker);
      });
    } finally {
      // 跑完即退（正常 done/error 已自行存活至父进程收割；兜底确保不残留）
      child.kill();
    }
  };
}
