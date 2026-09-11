import { describe, it, expect } from 'vitest';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { createModels, Type } from '@earendil-works/pi-ai';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from '@earendil-works/pi-ai/providers/faux';

/**
 * 验证点①：注册自定义 TypeBox 工具，Faux 模型发起工具调用，工具真实执行。
 *
 * 实际 API（与计划假设的差异，详见 VERDICT.md）：
 * - AgentTool 需要必填 label；execute 签名为 (toolCallId, params, signal?, onUpdate?)
 *   返回 AgentToolResult { content: [{type:'text',text}], details }
 * - Faux 通过 fauxProvider() handle 脚本化：setResponses([fauxAssistantMessage(...)])
 */
describe('Spike1: 自定义工具注册与执行', () => {
  it('Faux 模型的工具调用被真实执行，工具结果回到模型并产生最终回答', async () => {
    const executed: Array<{ text: string }> = [];

    const echo: AgentTool<{ text: string }, { text: string }> = {
      name: 'echo',
      label: '回声',
      description: '回声工具',
      parameters: Type.Object({
        text: Type.String({ description: '要回显的内容' }),
      }),
      execute: async (_toolCallId, params) => {
        executed.push(params);
        return {
          content: [{ type: 'text', text: JSON.stringify({ echo: params.text }) }],
          details: params,
        };
      },
    };

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();

    // 脚本：第一轮发起 echo 工具调用，第二轮基于工具结果给出最终回答
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('echo', { text: '你好' })),
      fauxAssistantMessage(fauxText('已完成回声调用')),
    ]);

    const agent = new Agent({
      initialState: {
        systemPrompt: '你是数字员工',
        model,
        tools: [echo],
      },
      streamFn: models.streamSimple.bind(models),
    });

    await agent.prompt('调用 echo 工具说你好');

    // 工具真实执行了一次，参数正确
    expect(executed).toHaveLength(1);
    expect(executed[0]).toEqual({ text: '你好' });

    // 会话包含完整的 工具结果 消息（模型能拿到执行结果）
    const toolResult = agent.state.messages.find((m) => m.role === 'toolResult');
    expect(toolResult).toBeDefined();

    // 最终轮 assistant 产生了文本回答
    const last = agent.state.messages.at(-1);
    expect(last?.role).toBe('assistant');
    expect(JSON.stringify(last)).toContain('已完成回声调用');
  });
});
