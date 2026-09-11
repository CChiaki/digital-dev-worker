import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../types.js';

/** pi 事件 → AgentEvent（P0-S3 实测映射）。返回 null 的事件不进直播流。 */
export function piEventToAgentEvent(piEvent: any, taskId: string, employeeId: string): AgentEvent | null {
  switch (piEvent.type) {
    case 'message_end':
      if (piEvent.message?.role === 'assistant') {
        const text = (piEvent.message.content ?? [])
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('');
        // token 用量透传（2026-09-11 P2 产品批）：assistant 消息天然带 usage（pi-ai 供给了
        // input/output/cacheRead/cacheWrite），附进 thinking payload 供直播/审计看每轮消耗；
        // 工具调用轮（无文本）不产事件——任务级累计在 EmployeeRuntime 从原始事件记账，不丢账
        const u = piEvent.message.usage as { input?: number; output?: number } | undefined;
        const usage = u ? { input: u.input ?? 0, output: u.output ?? 0 } : undefined;
        if (text) {
          return {
            id: randomUUID(), ts: Date.now(), taskId, employeeId,
            type: 'thinking', summary: text.slice(0, 200),
            payload: { content: text, ...(usage ? { usage } : {}) },
          };
        }
      }
      return null;
    case 'tool_execution_end':
      return {
        id: randomUUID(), ts: Date.now(), taskId, employeeId,
        type: 'tool_call',
        summary: piEvent.toolName,
        payload: { toolCallId: piEvent.toolCallId, result: piEvent.result, isError: piEvent.isError },
      };
    default:
      return null;
  }
}
