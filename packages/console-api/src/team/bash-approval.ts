import type { AgentEvent } from '@ddw/runtime';
import type { CheckGate } from '@ddw/runtime';

/** bash-approval 工厂的 emit 形状：id/ts/taskId/employeeId 由调用方绑定补齐 */
export type ApprovalEmit = (e: Pick<AgentEvent, 'type' | 'summary' | 'payload'>) => Promise<void>;

/**
 * run_cmd 白名单外命令人工放行（2026-09-10 用户需求）：
 * 完整复用 task_check 闸门链路——task_check(awaiting) 事件自动生成「待人工放行」消息
 * （SSE 推送 + 铃铛 + 菜单角标零改动），listPendingChecks 自动进 GET /api/checks 待审列表，
 * 人工放行 API（POST /api/tasks/:id/checks/:item/review）直接裁决，前端零改动。
 *
 * 与 checkpoint.ts 同款防竞态时序：先注册 gate.review 挂起，再发 awaiting 事件——
 * 审批人看到待审去放行时 resolver 必已就位，无 404 窗口。
 *
 * 记忆语义（用户选定）：同任务内同首 token 命令放行过一次即记住（Set，任务结束即弃）——
 * 按命令名而非完整命令行记（docker ps / docker images 同算 docker），重复审批不打扰。
 * 黑名单与组合命令在 ControlledBash 层就硬拒，到不了这里。
 */
export function makeBashApproval(deps: {
  gate: CheckGate;
  emit: ApprovalEmit;
}): (cmd: string) => Promise<{ approved: boolean; comment?: string }> {
  let seq = 0;
  const remembered = new Set<string>();
  return async (cmd) => {
    const head = cmd.trim().split(/\s+/)[0]!.split('/').pop()!; // 首 token basename，与白名单同口径
    if (remembered.has(head)) return { approved: true };
    const item = `bash-${++seq}`;
    const pendingVerdict = deps.gate.review({ item, result: cmd, passed: true });
    await deps.emit({
      type: 'task_check',
      summary: `白名单外命令待放行：${cmd.slice(0, 200)}`,
      payload: { item, passed: true, result: cmd, awaiting: true, bash: true },
    });
    const verdict = await pendingVerdict;
    await deps.emit({
      type: 'intervention',
      summary: verdict.approved
        ? `人工放行白名单外命令：${head}${verdict.operator ? `（${verdict.operator}）` : ''}`
        : `人工驳回白名单外命令：${head}${verdict.operator ? `（${verdict.operator}）` : ''}${verdict.comment ? `：${verdict.comment}` : ''}`,
      payload: {
        item, approved: verdict.approved,
        ...(verdict.comment ? { comment: verdict.comment } : {}),
        ...(verdict.operator ? { operator: verdict.operator } : {}),
      },
    });
    if (verdict.approved) remembered.add(head);
    return verdict;
  };
}
