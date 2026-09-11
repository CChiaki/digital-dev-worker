import { describe, it, expect } from 'vitest';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { streamSimple as openaiStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { Model } from '@earendil-works/pi-ai';

/**
 * 验证点⑥：vLLM OpenAI 兼容端点冒烟。
 *
 * 内网 vLLM 部署（glm/qwen 私有化集群）走 OpenAI 兼容协议，pi 侧只需构造一个
 * api="openai-completions" 的 Model（baseUrl 指向 vLLM）即可直连，无需自定义 provider。
 *
 * 由环境变量控制，未设置自动 skip（CI/本地无 vLLM 时不出红）：
 *   PI_SPIKE_VLLM_URL=http://<host>:<port>/v1
 *   PI_SPIKE_VLLM_MODEL=<模型名，如 /models/glm-5.3-flash>
 *   PI_SPIKE_VLLM_API_KEY=<可省，vLLM 通常不校验，缺省用 "none">
 */

const VLLM_URL = process.env.PI_SPIKE_VLLM_URL;
const VLLM_MODEL = process.env.PI_SPIKE_VLLM_MODEL;

function makeVllmModel(): Model<'openai-completions'> {
  return {
    id: VLLM_MODEL!,
    name: VLLM_MODEL!,
    api: 'openai-completions',
    provider: 'vllm-custom',
    baseUrl: VLLM_URL!,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

describe.skipIf(!VLLM_URL || !VLLM_MODEL)('Spike6: vLLM OpenAI 兼容冒烟', () => {
  it('纯文本：vLLM 直连一轮对话可流式返回', { timeout: 60_000 }, async () => {
    const model = makeVllmModel();
    const agent = new Agent({
      initialState: {
        systemPrompt: '你是一个测试助手，回答保持一句话。',
        model,
        tools: [],
      },
      streamFn: openaiStreamSimple,
    });

    const deltas: string[] = [];
    agent.subscribe((e) => {
      if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') {
        deltas.push(e.assistantMessageEvent.delta);
      }
    });

    await agent.prompt('用一句话回答：1+1等于几？');

    const final = agent.state.messages.at(-1);
    expect(final?.role).toBe('assistant');
    expect(JSON.stringify(final).length).toBeGreaterThan(0);
    // 流式 delta 真实到达（vLLM SSE 分块）
    expect(deltas.join('').length).toBeGreaterThan(0);
  });

  it('工具调用：vLLM 模型完成 toolCall → toolResult 循环', { timeout: 120_000 }, async () => {
    const model = makeVllmModel();
    const now: AgentTool<Record<string, never>, { iso: string }> = {
      name: 'get_time',
      label: '取当前时间',
      description: '获取服务器当前时间，返回 ISO 字符串',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      } as never,
      execute: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ iso: new Date().toISOString() }) }],
        details: { iso: new Date().toISOString() },
      }),
    };

    const agent = new Agent({
      initialState: {
        systemPrompt: '你可以调用工具。回答完问题后停止。',
        model,
        tools: [now],
      },
      streamFn: openaiStreamSimple,
    });

    await agent.prompt('请调用 get_time 工具查一下现在几点，然后告诉我。');

    const msgs = agent.state.messages;
    expect(msgs.some((m) => m.role === 'toolResult')).toBe(true);
    const final = msgs.at(-1)!;
    expect(final.role).toBe('assistant');
    expect(JSON.stringify(final)).not.toContain('"toolCall"');
  });
});
