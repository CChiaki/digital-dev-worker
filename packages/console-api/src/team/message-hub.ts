import type { AgentEvent, EmployeeOutcome, TaskPackage } from '@ddw/runtime';
import type { EventStore, EventFilter, TaskStore, TaskRecord } from '../stores/index.js';
import type { MessageRecord, MessageType } from './messages.js';

/** 消息出口（server 接线：FileMessageStore 落库 + 通知渠道推送；Task 6 前只落库） */
export interface MessageSink {
  onMessage(m: Omit<MessageRecord, 'id' | 'createdAt' | 'readAt'>): Promise<void>;
}

/** 三类消息的统一标题与摘要组装（title 含 taskId，列表页可直接读） */
const msg = (type: MessageType, taskId: string, summary: string, employeeId?: string) => ({
  type,
  taskId,
  summary,
  title: type === 'review_required'
    ? `任务 ${taskId} 待人工放行`
    : type === 'task_failed'
      ? `任务 ${taskId} 执行失败`
      : type === 'skill_pending'
        ? `任务 ${taskId} 沉淀 Skill 待审查`
        : `任务 ${taskId} 执行完成`,
  ...(employeeId ? { employeeId } : {}),
});

/** 事件侧装饰器：task_check awaiting=true → review_required；其余纯透传。
 *  onEvent（2026-09-10 用户反馈）：事件落库后的旁路钩子——放行裁决（intervention）事件
 *  不生成消息，但直接影响待审计数，server 用此钩子在裁决落库时即时重算角标（原实现只能等
 *  60s 周期对账，角标消退还慢） */
export function wrapEventStoreForMessages(
  base: EventStore,
  sink: MessageSink,
  onEvent?: (e: AgentEvent) => void,
): EventStore {
  return {
    append: async (e: AgentEvent) => {
      await base.append(e);
      onEvent?.(e);
      if (e.type === 'task_check' && (e.payload as { awaiting?: boolean } | undefined)?.awaiting === true) {
        await sink.onMessage(msg('review_required', e.taskId, e.summary, e.employeeId));
      }
      // Skill 沉淀候选（2026-09-06 蒸馏器）：report 事件 payload.skillPending=true → 待审查消息
      if (e.type === 'report' && (e.payload as { skillPending?: boolean } | undefined)?.skillPending === true) {
        await sink.onMessage(msg('skill_pending', e.taskId, e.summary, e.employeeId));
      }
    },
    list: (f?: EventFilter) => base.list(f),
    ...(base.verifyIntegrity ? { verifyIntegrity: () => base.verifyIntegrity!() } : {}),
    ...(base.snapshotHead ? { snapshotHead: () => base.snapshotHead!() } : {}),
  };
}

/** 任务池侧装饰器：finish 落定 → task_done/task_failed；其余纯透传（含 add 的 draft opts） */
export function wrapTaskStoreForMessages(base: TaskStore, sink: MessageSink): TaskStore {
  const finishMsg = (taskId: string, outcome: EmployeeOutcome, ok: boolean) =>
    msg(ok ? 'task_done' : 'task_failed', taskId, outcome.reply);
  return {
    add: (pkg: TaskPackage, opts?: { draft?: boolean }) => base.add(pkg, opts),
    publish: (taskId: string) => base.publish(taskId),
    assign: (taskId: string, employeeId: string | null) => base.assign(taskId, employeeId),
    get: (taskId: string) => base.get(taskId),
    list: () => base.list(),
    claim: (taskId: string, employeeId: string) => base.claim(taskId, employeeId),
    markRunning: (taskId: string) => base.markRunning(taskId),
    finish: async (
      taskId: string,
      outcome: EmployeeOutcome,
      ok: boolean,
      progress?: Parameters<TaskStore['finish']>[3],
      failedItemId?: string,
    ): Promise<TaskRecord> => {
      const rec = await base.finish(taskId, outcome, ok, progress, failedItemId);
      await sink.onMessage(finishMsg(taskId, outcome, ok));
      return rec;
    },
    resumePlan: (taskId: string) => base.resumePlan(taskId),
    // 强制重置（2026-09-11）：纯透传——不生成消息（重置本身在 handlers 侧留 dispatch 事件）
    resetToPending: (taskId: string) => base.resetToPending(taskId),
  };
}
