import { randomUUID } from 'node:crypto';
import type { AgentEvent, EmployeeOutcome, EmployeeProfile, TaskPackage } from '@ddw/runtime';
import type { TaskRecord, TaskStore, EventStore } from '../stores/index.js';
import type { EmployeeExecutor } from './executor.js';
import type { SchedulerRoster } from './managed-roster.js';
import { log, errLine } from './logger.js';

export interface TeamSchedulerDeps {
  tasks: TaskStore;
  /** 调度事件留痕（dispatch/blocked 全程可溯） */
  events: EventStore;
  /** 名册（2026-09-06 起收窄为最小接口，EmployeeRoster / ManagedRoster 均满足） */
  roster: SchedulerRoster;
  /** 分派前谓词（2026-09-06）：如员工能力绑定过滤；返回 false 该员工跳过 */
  canDispatch?: (task: TaskRecord, employee: EmployeeProfile) => boolean;
  /** 任务成功完成回调（2026-09-06 蒸馏钩子）：仅 ok=true 触发，异步不阻塞 finish 回写；
   *  回调内部异常只 console.error，不得炸 tick */
  onTaskComplete?: (task: TaskPackage, employee: EmployeeProfile) => Promise<void> | void;
  executor: EmployeeExecutor;
  /** tick 是否等待本轮分派的任务全部完成再返回（默认 true，P8 测试确定性语义）。
   *  生产一体化模式传 false：tick 只分派不等完成——人工放行闸门阻塞 runOne 时不得拖死新任务分派（P10）。 */
  awaitCompletion?: boolean;
  /** 任务级 wall-clock 看门狗（2026-09-11 P0 韧性批）：running 超过此时长 →
   *  failed「任务超时」+ 释放员工占用；挂审待放行（listPendingChecks 命中）4 倍宽限。
   *  缺省 = 看门狗关闭。事件流推导待审需要 events —— 不注入 pendingChecksOf 时无宽限（仅按时长） */
  taskTimeoutMs?: number;
  /** 待审推导（看门狗宽限判定用，2026-09-11）：缺省不宽限；生产注入 listPendingChecks */
  pendingChecksOf?: () => Promise<{ taskId: string }[]>;
}

/** 依赖就绪判定结果 */
type Readiness =
  | { state: 'ready' }
  | { state: 'waiting'; reason: string }   // 有依赖未完成（正常等待，不告警）
  | { state: 'blocked'; reason: string };  // 上游失败/依赖缺失（需人工处理）

/**
 * 班组调度器（P8，spec 4.2 真编排引入）：只做分派决策，执行拉起是注入的 executor。
 * tick() 一轮：扫任务池 → 依赖就绪（dependsOn 全 done）→ 岗位匹配（role ∈ 员工 skills）
 * → 空闲员工原子 claim → 并行执行 → finish 回写。
 * 失败传播保守取向：上游 failed → 下游 blocked，不自动恢复。
 */
export class TeamScheduler {
  private readonly inFlight = new Set<string>(); // 本轮已分派、尚未回写的 taskId
  private readonly lastNote = new Map<string, string>(); // blocked/waiting 去重：状态没变不重复留痕
  private tail: Promise<unknown> = Promise.resolve(); // tick 串行化：并发触发排队执行，杜绝重复分派
  private pendingEmits: Promise<void>[] = []; // 留痕写盘统一 flush，tick 返回时事件已落库
  private seq = 0;
  /** 看门狗/强制重置已收割的 taskId（2026-09-11 P0 韧性批）：runOne 迟到返回时跳过
   *  finish 回写与员工释放（此时任务可能已被重置/重新分派——覆盖回写会把新一轮执行态
   *  写坏，重复 release 会把已重新占用的员工误置空闲）。任务重新分派时（tickInner）清除 */
  private readonly reaped = new Set<string>();

  constructor(private readonly deps: TeamSchedulerDeps) {}

  /**
   * 执行一轮调度：分派所有可运行任务并等待本轮全部完成（串行确定性，便于测试与由外部定时触发）。
   * 并发调用排队执行（同一实例内不会重复分派同一任务）。返回本轮分派的任务数。
   */
  tick(): Promise<number> {
    const run = this.tail.then(() => this.tickInner());
    this.tail = run.catch(() => {});
    return run;
  }

  private async tickInner(): Promise<number> {
    const records = await this.deps.tasks.list();
    const byId = new Map(records.map((r) => [r.pkg.taskId, r]));
    const dispatches: Promise<void>[] = [];
    let dispatched = 0;

    for (const rec of records) {
      const taskId = rec.pkg.taskId;
      if (rec.status !== 'pending' || this.inFlight.has(taskId)) continue;

      const readiness = this.readinessOf(rec, byId);
      if (readiness.state === 'blocked') {
        this.note(taskId, `blocked: ${readiness.reason}`, undefined);
        continue;
      }
      if (readiness.state === 'waiting') {
        this.note(taskId, `waiting: ${readiness.reason}`, undefined);
        continue;
      }

      // 分派（2026-09-06 assignee）：指定员工 → 点名（忽略 role 匹配）；未指定 → 按岗位挑空闲。
      // canDispatch 谓词（2026-09-06）仅在按岗位路径生效；点名即指定，不再过滤。
      // assignee 消费侧 trim（T1 Minor① 兜底：存值未 trim）
      const assignee = rec.pkg.assignee?.trim() || undefined;
      const employee = assignee
        ? this.deps.roster.acquireById(assignee)
        : this.deps.roster.acquire(
            // 任务包 role 消费侧 trim（2026-09-08 T3 档案卫生兜底：存值可能带空白，
            // 岗位匹配是精确等值——与 assignee 同在调度分派决策点收口）
            rec.pkg.role?.trim() || undefined,
            this.deps.canDispatch ? (p) => this.deps.canDispatch!(rec, p) : undefined,
          );
      if (!employee) {
        this.note(
          taskId,
          assignee
            ? this.deps.roster.isKnown(assignee)
              ? `waiting: 指定员工 ${assignee} 正忙，完成后自动分派`
              : `waiting: 指定员工不可用（${assignee}），等人工处理`
            : 'waiting: 无空闲员工匹配岗位',
          undefined,
        );
        continue;
      }

      // 原子抢单：并发 tick / 外部抢占下非 pending 会抛错，跳过即可
      try {
        await this.deps.tasks.claim(taskId, employee.id);
        await this.deps.tasks.markRunning(taskId);
      } catch {
        this.deps.roster.release(employee.id);
        continue;
      }

      this.inFlight.add(taskId);
      this.reaped.delete(taskId); // 新一轮执行开始（2026-09-11）：上一代收割标记随之失效
      dispatched++;
      this.emit('dispatch', taskId, employee.id, `分派任务 ${taskId} → ${employee.id}（${employee.name}）`);
      dispatches.push(this.runOne(taskId, employee));
    }

    if (this.deps.awaitCompletion !== false) {
      await Promise.allSettled(dispatches); // 本轮分派的任务全部落定后再返回（测试确定性语义）
    }
    await Promise.all(this.pendingEmits);
    this.pendingEmits = [];
    return dispatched;
  }

  /** 单任务执行 + 回写 + 归还员工 */
  private async runOne(taskId: string, employee: EmployeeProfile): Promise<void> {
    const rec = await this.deps.tasks.get(taskId);
    if (!rec) return;
    let outcome: EmployeeOutcome;
    let ok = false;
    try {
      outcome = await this.deps.executor({ task: rec.pkg, employee, ...(rec.planProgress ? { progress: rec.planProgress } : {}) });
      // 计划模式：链停（failedItemId 在场）语义上视为 failed（可 resume 续跑）；老 tasks 包零回归
      ok = outcome.status === 'done' && outcome.failedItemId === undefined;
    } catch (e) {
      outcome = { status: 'done' as const, reply: `执行异常: ${e instanceof Error ? e.message : String(e)}`, turns: 0 };
      ok = false;
    }
    // 迟到回写守卫（2026-09-11 P0 韧性批）：看门狗超时收割 / 强制重置后 runOne 才返回——
    // 此时不得覆盖新状态（任务可能已重置回 pending 甚至已重新分派跑完），员工也不再归还
    // （收割时已释放；若期间已被新任务重新占用，重复 release 会误置空闲造成并发分派）
    if (this.reaped.has(taskId)) {
      this.reaped.delete(taskId);
      this.emit('dispatch', taskId, employee.id, `任务 ${taskId} 执行结果迟到（已被收割/重置），丢弃回写`);
      this.inFlight.delete(taskId);
      return;
    }
    await this.deps.tasks.finish(taskId, outcome, ok, outcome.planProgress, outcome.failedItemId);
    // 蒸馏钩子（2026-09-06）：仅成功完成的任务触发 Skill 沉淀，fire-and-forget 不阻塞回写；
    // 异步异常只 console.error，绝不影响任务终态
    if (ok && this.deps.onTaskComplete) {
      void Promise.resolve(this.deps.onTaskComplete(rec.pkg, employee))
        .catch((e) => log.error('scheduler', 'onTaskComplete 失败:', errLine(e)));
    }
    this.emit('dispatch', taskId, employee.id, ok ? `任务 ${taskId} 完成（${employee.id}）` : `任务 ${taskId} 执行失败（${employee.id}），下游依赖已被阻断`);
    this.deps.roster.release(employee.id);
    this.inFlight.delete(taskId);
  }

  /**
   * 看门狗巡检（2026-09-11 P0 韧性批）：running 超 taskTimeoutMs → failed「任务超时」+
   * 释放员工 + 收割标记（迟到回写守卫）。挂审待放行任务 4 倍宽限——等人工放行不是 hang，
   * 误杀会让整个任务前功尽弃。返回本轮收割数（0 = 无超时）。
   * 不带 progress 调 finish：COALESCE 语义保留已跑完的计划项，续跑可从断点接。
   */
  async watchdogSweep(): Promise<number> {
    const limit = this.deps.taskTimeoutMs;
    if (!limit) return 0;
    let awaiting: Set<string> | undefined;
    try {
      awaiting = new Set((await this.deps.pendingChecksOf?.() ?? []).map((c) => c.taskId));
    } catch {
      /* 待审推导失败按无宽限处理（宁可保守超时也不无限等） */
    }
    const records = await this.deps.tasks.list();
    const now = Date.now();
    let reaped = 0;
    for (const rec of records) {
      if (rec.status !== 'claimed' && rec.status !== 'running') continue;
      if (!rec.claimedAt) continue;
      const effLimit = awaiting?.has(rec.pkg.taskId) ? limit * 4 : limit;
      if (now - rec.claimedAt <= effLimit) continue;
      const taskId = rec.pkg.taskId;
      // 与 tick 串行化（同一 tail），杜绝「收割瞬间 tick 又分派」的竞态
      await this.tail;
      await this.reap(taskId, rec.claimedBy, `任务超时（wall-clock ${Math.round(effLimit / 60000)} 分钟，claimedAt ${new Date(rec.claimedAt).toISOString()}）——模型 hang 或无人放行，看门狗收割`);
      reaped++;
    }
    return reaped;
  }

  /**
   * 强制重置前置收割（2026-09-11）：force-reset API 对在途（claimed/running）任务调用——
   * 标记收割 + 摘除 inFlight + 释放该任务占用的员工；随后 store.resetToPending 清执行态。
   * 迟到回写守卫同看门狗。调用侧保证只在任务仍在途时传 claimedBy（终态任务的 claimedBy
   * 可能已被新任务重新占用，误释放会造成并发分派）。
   */
  abandon(taskId: string, claimedBy?: string): void {
    this.reaped.add(taskId);
    this.inFlight.delete(taskId);
    if (claimedBy) this.deps.roster.release(claimedBy);
  }

  /** 收割单任务（看门狗共用）：failed 回写 + 释放员工 + 收割标记 + 留痕 */
  private async reap(taskId: string, claimedBy: string | undefined, reason: string): Promise<void> {
    this.reaped.add(taskId);
    this.inFlight.delete(taskId);
    try {
      // status 用 max_turns（EmployeeOutcome 语义：非正常终止的统一标记，同 crashOutcome）
      await this.deps.tasks.finish(
        taskId,
        { status: 'max_turns' as const, reply: `${reason}。可续跑（保留进度）或编辑重跑`, turns: 0 },
        false,
      );
    } catch (e) {
      // 收割失败（任务已被并发改态）：保留收割标记防迟到回写，但不释放员工（占用关系未证实）
      log.error('scheduler', `看门狗收割失败 ${taskId}:`, errLine(e));
      return;
    }
    if (claimedBy) this.deps.roster.release(claimedBy);
    this.emit('dispatch', taskId, claimedBy ?? 'scheduler', `任务 ${taskId} ${reason}`);
  }

  /** 依赖就绪判定：dependsOn 全 done → ready；任一 failed → blocked；任一缺失 → blocked */
  private readinessOf(rec: TaskRecord, byId: Map<string, TaskRecord>): Readiness {
    const deps = rec.pkg.dependsOn ?? [];
    for (const depId of deps) {
      const dep = byId.get(depId);
      if (!dep) return { state: 'blocked', reason: `依赖的任务包不存在: ${depId}` };
      if (dep.status === 'failed') return { state: 'blocked', reason: `上游任务失败: ${depId}` };
      if (dep.status !== 'done') return { state: 'waiting', reason: `等待上游任务: ${depId}（${dep.status}）` };
    }
    return { state: 'ready' };
  }

  /** 留痕去重：同任务同状态只记一次，状态变化再记 */
  private note(taskId: string, note: string, employeeId: string | undefined): void {
    if (this.lastNote.get(taskId) === note) return;
    this.lastNote.set(taskId, note);
    this.emit('dispatch', taskId, employeeId ?? 'scheduler', note);
  }

  /** 重启去重播种（2026-09-11 用户复盘批）：lastNote 是进程内存态，重启后首轮 tick 会把
   *  状态没变的 blocked/waiting 任务重复留痕一次。启动时从事件库回放各任务最近一条此类
   *  留痕 seed 进缓存——状态未变则不再记。失败只告警（退化为现状：重启后多记一条），不阻塞启动 */
  async seedNotes(): Promise<void> {
    try {
      const evts = await this.deps.events.list({ type: 'dispatch' });
      // 按 ts 升序回放：同任务多条留痕时后写覆盖，最终缓存 = 各任务最近一条
      const notes = evts
        .filter((e) => (e.summary ?? '').startsWith('blocked: ') || (e.summary ?? '').startsWith('waiting: '))
        .sort((a, b) => a.ts - b.ts);
      for (const e of notes) this.lastNote.set(e.taskId, e.summary!);
      if (notes.length > 0) log.info('scheduler', `留痕去重播种：回放 ${notes.length} 条 blocked/waiting 留痕`);
    } catch (e) {
      log.warn('scheduler', '留痕去重播种失败（重启后可能多记一条）:', errLine(e));
    }
  }

  private emit(type: AgentEvent['type'], taskId: string, employeeId: string, summary: string): void {
    this.pendingEmits.push(
      this.deps.events.append({
        // 全局唯一：内存序号在服务重启/多实例下会与库中已有行撞车（UNIQUE constraint
        // 曾整进程崩溃），id 一次性生成后永不复用
        id: `sched-${taskId}-${++this.seq}-${randomUUID().slice(0, 8)}`,
        ts: Date.now(),
        taskId,
        employeeId,
        type,
        summary,
      }).then(() => undefined),
    );
  }
}
