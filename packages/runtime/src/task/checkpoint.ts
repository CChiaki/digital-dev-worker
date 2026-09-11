import type { AgentEvent, Tool, ToolParamSpec, ToolResult } from '../types.js';

const p = (type: string, description: string, required = false): ToolParamSpec[string] =>
  ({ type, description, required });

/**
 * 人工放行闸门（P10 人工盯梢闭环，spec 4.4 shadow 期）：
 * task_check 申报后阻塞等待人工复核——放行则员工继续，驳回（带意见）则
 * 工具返回 error，模型看到错误自然修正后重新申报。
 */
export interface CheckGate {
  /** verdict.operator（2026-09-11）：裁决人身份（API token 的操作者名），intervention 事件留痕用 */
  review(check: { item: string; result: string; passed: boolean }): Promise<{ approved: boolean; comment?: string; operator?: string }>;
}

/**
 * 节点申报工具 task_check（spec 4.4 节点 checkpoint）：数字员工每完成一个任务项，
 * 主动申报该项的验收结果，emit `task_check` 事件——审计台账"清单打勾"视图的数据源，
 * 二期班组编排以它为"上游产物就绪"信号。
 *
 * 模型自主申报（与软编排一致：清单是给模型的 checklist），但 runtime 校验：
 * passed=false 拒绝（防误报完成）、item 不在任务包清单拒绝（防漏报/乱报）。
 * 注入 gate（shadow 盯梢）时申报后阻塞等待人工放行；无 gate 行为不变（零回归）。
 */
export function createTaskCheckTool(deps: {
  emit: (e: Omit<AgentEvent, 'id' | 'ts' | 'taskId' | 'employeeId'>) => Promise<void>;
  /** 任务包清单；非任务包执行可不传，仅校验参数（DevTask/PlanItem 均兼容，工具只消费 id） */
  items?: { id: string }[];
  /** 人工放行闸门（shadow 级注入）；缺省 = 申报即通过（P6-I 行为零回归） */
  gate?: CheckGate;
}): Tool[] {
  const legalIds = deps.items?.map((t) => t.id);
  return [
    {
      name: 'task_check',
      description:
        '申报一个任务节点完成：自测/验收通过后调用，逐项打勾。未通过请继续处理，不要申报。被人工驳回时按驳回意见修正后可重新申报。',
      parameters: {
        item: p('string', '任务项 id（如 T-1）', true),
        result: p('string', 'acceptance 执行结果摘要（如 "npm run build 通过，3 断言全绿"）', true),
        passed: p('boolean', '是否通过，默认 true；false 会被拒绝'),
      },
      async execute(args): Promise<ToolResult> {
        const item = args['item'];
        const result = args['result'];
        if (typeof item !== 'string' || typeof result !== 'string') {
          return { ok: false, error: '缺少参数 item / result' };
        }
        const passed = args['passed'] === undefined ? true : args['passed'] === true;
        if (!passed) {
          return { ok: false, error: `节点 ${item} 未通过，请继续处理完成后再申报（申报会被审计留痕）` };
        }
        if (legalIds && !legalIds.includes(item)) {
          return { ok: false, error: `任务项 ${item} 不在任务包清单中，合法项: ${legalIds.join(', ')}` };
        }
        // 人工盯梢闸门：先注册等待再 emit（申报事件一可见，待审即可被复核——
        // 反过来会有"看到待审去放行却 404"的竞态窗口）；每次复核结果 intervention 留痕
        const pendingVerdict = deps.gate ? deps.gate.review({ item, result, passed }) : undefined;
        await deps.emit({
          type: 'task_check',
          summary: `${item} 节点完成：${result.slice(0, 200)}`,
          payload: { item, passed, result, ...(pendingVerdict ? { awaiting: true } : {}) },
        });
        if (pendingVerdict) {
          const verdict = await pendingVerdict;
          await deps.emit({
            type: 'intervention',
            summary: verdict.approved
              ? `人工放行节点 ${item}${verdict.operator ? `（${verdict.operator}）` : ''}${verdict.comment ? `：${verdict.comment}` : ''}`
              : `人工驳回节点 ${item}${verdict.operator ? `（${verdict.operator}）` : ''}${verdict.comment ? `：${verdict.comment}` : ''}`,
            payload: {
              item, approved: verdict.approved,
              ...(verdict.comment ? { comment: verdict.comment } : {}),
              ...(verdict.operator ? { operator: verdict.operator } : {}),
            },
          });
          if (!verdict.approved) {
            return {
              ok: false,
              error: `节点 ${item} 被人工驳回${verdict.comment ? `：${verdict.comment}` : ''}。请按意见修正后重新申报。`,
            };
          }
        }
        return { ok: true, data: { item, checked: true } };
      },
    },
  ];
}
