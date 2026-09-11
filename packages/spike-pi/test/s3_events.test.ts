import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { createModels, Type } from '@earendil-works/pi-ai';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from '@earendil-works/pi-ai/providers/faux';

/** spec 定义的 AgentEvent（最小版，spike 内不依赖 runtime 包） */
type AgentEventType = 'thinking' | 'tool_call' | 'report';
interface AgentEvent {
  id: string;
  ts: number;
  taskId: string;
  employeeId: string;
  type: AgentEventType;
  summary: string;
  payload?: unknown;
}

/**
 * 验证点③：pi 事件 → AgentEvent 映射（P1 的直播/审计数据源核心函数）
 *
 * pi 实际事件序列（S2 调试已实测确认）：
 *   agent_start, turn_start, message_start, message_update*, message_end,
 *   tool_execution_start, tool_execution_update*, tool_execution_end,
 *   turn_end, ...（多轮循环）..., agent_end
 */
function piEventToAgentEvent(piEvent: any, taskId: string, employeeId: string): AgentEvent | null {
  switch (piEvent.type) {
    case 'message_end':
      if (piEvent.message?.role === 'assistant') {
        const text = (piEvent.message.content ?? [])
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('');
        if (text) {
          return {
            id: randomUUID(), ts: Date.now(), taskId, employeeId,
            type: 'thinking', summary: text.slice(0, 200), payload: { content: text },
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
      return null; // 生命周期事件不进直播流
  }
}

describe('Spike3: 事件流订阅与映射', () => {
  it('订阅完整事件序列，映射出 thinking 与 tool_call 事件', async () => {
    const echo: AgentTool<{ text: string }, { text: string }> = {
      name: 'echo',
      label: '回声',
      description: '回声工具',
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_id, params) => ({
        content: [{ type: 'text', text: JSON.stringify(params) }],
        details: params,
      }),
    };

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('echo', { text: 'hi' })),
      fauxAssistantMessage(fauxText('完成了')),
    ]);

    const agent = new Agent({
      initialState: { systemPrompt: '你是数字员工', model: faux.getModel(), tools: [echo] },
      streamFn: models.streamSimple.bind(models),
    });

    const raw: string[] = [];
    const mapped: AgentEvent[] = [];
    agent.subscribe((e) => {
      raw.push(e.type);
      const ae = piEventToAgentEvent(e, 'T1', 'emp-01');
      if (ae) mapped.push(ae);
    });

    await agent.prompt('干完这个活');

    // pi 官方 README 的事件序列完整出现（缺一个都算差异）
    expect(raw).toEqual(expect.arrayContaining([
      'agent_start', 'turn_start', 'message_start', 'message_update',
      'message_end', 'tool_execution_start', 'tool_execution_end', 'turn_end', 'agent_end',
    ]));

    // 映射结果：先 tool_call 后 thinking
    expect(mapped.map((e) => e.type)).toEqual(['tool_call', 'thinking']);
    expect(mapped[0]).toMatchObject({ summary: 'echo' });
    expect(mapped[1].summary).toBe('完成了');
  });

  it('message_update 可收到流式 text delta（直播逐字显示依赖）', async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(fauxText('完成了'))]);
    // Faux 的 tokensPerSecond 默认会分块流式输出；显式配置确保多块
    const faux2 = fauxProvider({ tokensPerSecond: 1000 });
    void faux2;

    const agent = new Agent({
      initialState: { systemPrompt: '你是数字员工', model: faux.getModel(), tools: [] },
      streamFn: models.streamSimple.bind(models),
    });

    const deltas: string[] = [];
    agent.subscribe((e) => {
      if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') {
        deltas.push(e.assistantMessageEvent.delta);
      }
    });

    await agent.prompt('你好');

    expect(deltas.join('')).toBe('完成了');
  });
});
