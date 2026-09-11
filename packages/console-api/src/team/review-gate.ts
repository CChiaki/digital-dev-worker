import type { CheckGate } from '@ddw/runtime';
import type { EventStore, TaskStore } from '../stores/index.js';

/** 待审条目（GET /api/checks 数据源） */
export interface PendingCheck {
  taskId: string;
  item: string;
  result: string;
}

/** 放行记录（2026-09-10 用户需求：人工放行页默认查待办、过滤看全部历史）：
 *  每条 task_check(awaiting) 申报 + 后续 intervention 裁决（若有） */
export interface CheckRecord {
  taskId: string;
  item: string;
  result: string;
  /** run_cmd 白名单外命令放行（bash-approval 链路）：true 时 result 为命令行 */
  bash?: boolean;
  /** 申报时间（task_check 事件 ts） */
  checkTs: number;
  /** 尚无裁决 = 待审 */
  pending: boolean;
  /** 裁决结果（intervention 事件）；pending 时缺省 */
  approved?: boolean;
  /** 作废裁决（2026-09-11 P1 治理批）：失效待审被人工作废留痕（approved 互斥出现） */
  voided?: boolean;
  comment?: string;
  /** 裁决人（2026-09-11 API token 操作者名，鉴权未启用/历史数据缺省） */
  operator?: string;
  verdictTs?: number;
  /** 已失效（2026-09-10 幽灵待审）：任务已不在执行中且始终未裁决——执行已结束，
   *  resolver 随之消亡，放行必 404；历史视图标记出来而非静默丢弃 */
  expired?: boolean;
}

/**
 * 人工复核队列（P10 盯梢闭环，console 侧闸门实现）：
 * task_check 申报 → wait() 挂起工具执行 → 控制台 approve/reject 唤醒。
 * 队列本身无状态持久化——待审列表从事件流推导（重启安全，见 handlers 的 GET /api/checks），
 * resolver 只服务于运行中任务的内存唤醒（任务重启即断，与 session 落盘续跑策略一致）。
 */
export class CheckReviewQueue {
  private readonly pending = new Map<string, (v: { approved: boolean; comment?: string }) => void>();

  /** 待审 key（taskId + 节点 id；同节点重新申报 = 新 key 覆盖旧挂起，旧 resolver 以驳回兜底唤醒） */
  private static key(taskId: string, item: string): string {
    return `${taskId}::${item}`;
  }

  /** 闸门入口：task_check 工具内调用，阻塞到人工复核 */
  wait(taskId: string, check: { item: string; result: string; passed: boolean }): Promise<{ approved: boolean; comment?: string }> {
    const key = CheckReviewQueue.key(taskId, check.item);
    // 同节点重复申报：旧的挂起 resolver 按驳回唤醒（防泄漏；实际 flow 中旧调用已返回）
    this.pending.get(key)?.({ approved: false, comment: '节点已重新申报，本次复核作废' });
    return new Promise((resolve) => {
      this.pending.set(key, resolve);
    });
  }

  /** 人工放行/驳回；未找到待审条目抛错（HTTP 层映射 404）。
   *  operator（2026-09-11）：API token 的操作者名，随 verdict 透传给 checkpoint/bash-approval
   *  写进 intervention 事件（审计留痕「谁放的行」）；鉴权未启用时缺省 */
  review(taskId: string, item: string, approved: boolean, comment?: string, operator?: string): void {
    const key = CheckReviewQueue.key(taskId, item);
    const resolve = this.pending.get(key);
    if (!resolve) {
      throw new Error(`待审节点不存在或已复核: ${taskId} / ${item}`);
    }
    this.pending.delete(key);
    resolve({ approved, ...(comment ? { comment } : {}), ...(operator ? { operator } : {}) });
  }
}

/**
 * 给任务构造闸门：CheckGate 接口不含 taskId，由闭包携带（executor 组装时 per-task 传入）。
 * 复核结果的 intervention 留痕由 runtime checkpoint 工具完成，queue 只负责唤醒。
 */
export function gateForTask(queue: CheckReviewQueue, taskId: string): CheckGate {
  return {
    review: (check) => queue.wait(taskId, check),
  };
}

/**
 * 放行全量记录推导（2026-09-10 用户需求）：task_check(awaiting) 申报逐条入记录，
 * 后续同节点 intervention 裁决补 approved/comment/verdictTs；同节点重新申报覆盖为新的待审。
 * tasks 可选：传入时对无裁决的待审标记任务存活——非执行中（终态/进程死亡残留）= expired。
 */
export async function listCheckHistory(events: EventStore, tasks?: TaskStore): Promise<CheckRecord[]> {
  const all = await events.list();
  const recs = new Map<string, CheckRecord>();
  for (const e of all) {
    if (e.type === 'task_check' && (e.payload as { awaiting?: boolean } | undefined)?.awaiting === true) {
      const p = e.payload as { item: string; result: string; bash?: boolean };
      recs.set(`${e.taskId}::${p.item}`, {
        taskId: e.taskId, item: p.item, result: p.result,
        ...(p.bash === true ? { bash: true } : {}),
        checkTs: e.ts, pending: true,
      });
    }
    // 裁决事件（intervention，payload 带 approved）补全对应申报；无对应申报的忽略（孤儿/历史数据）。
    // 作废裁决（voided，2026-09-11 P1 治理批）：失效待审的 console 侧留痕，同样视同已裁决清待
    if (e.type === 'intervention') {
      const p = e.payload as { item: string; approved?: boolean; voided?: boolean; comment?: string; operator?: string };
      const rec = recs.get(`${e.taskId}::${p.item}`);
      if (rec && p.voided === true) {
        rec.pending = false;
        rec.voided = true;
        if (p.comment) rec.comment = p.comment;
        if (p.operator) rec.operator = p.operator;
        rec.verdictTs = e.ts;
      } else if (rec && typeof p.approved === 'boolean') {
        rec.pending = false;
        rec.approved = p.approved;
        if (p.comment) rec.comment = p.comment;
        if (p.operator) rec.operator = p.operator;
        rec.verdictTs = e.ts;
      }
    }
  }
  if (tasks) {
    // 幽灵待审过滤（2026-09-10）：执行结束（或进程死亡）后残留的待审永远等不到裁决，
    // 放行必 404——历史里标记 expired，待审计数/列表（listPendingChecks）直接排除
    const active = new Set(
      (await tasks.list())
        .filter((r) => r.status === 'claimed' || r.status === 'running')
        .map((r) => r.pkg.taskId),
    );
    for (const rec of recs.values()) {
      if (rec.pending && !active.has(rec.taskId)) rec.expired = true;
    }
  }
  return [...recs.values()];
}

/**
 * 待审列表推导（事件流，重启安全）：扫描 task_check 事件（awaiting: true）
 * 与后续 intervention 复核事件配对，尚未复核的最新申报即待审。
 * tasks 可选（2026-09-10）：传入时排除非执行中任务的幽灵待审（数值真实性——角标虚高的根因）。
 */
export async function listPendingChecks(events: EventStore, tasks?: TaskStore): Promise<PendingCheck[]> {
  const recs = await listCheckHistory(events, tasks);
  return recs
    .filter((r) => r.pending && !r.expired)
    .map(({ taskId, item, result }) => ({ taskId, item, result }));
}
