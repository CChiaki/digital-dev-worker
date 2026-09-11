import { describe, it, expect } from 'vitest';
import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { toPiTool } from '../src/tools/pi-adapter.js';
import { makeBeforeToolCall, BashBlacklist } from '../src/security/index.js';
import type { Tool } from '../src/types.js';

const echoTool: Tool = {
  name: 'echo',
  description: '回声',
  parameters: { text: { type: 'string', description: '内容', required: true } },
  async execute(args) {
    if (!('text' in args)) return { ok: false, error: '缺少 text' };
    return { ok: true, data: { echo: args.text } };
  },
};

describe('toPiTool', () => {
  it('Tool 包装为 pi AgentTool（label 必填、parameters 为 JSON Schema、结果转 text content）', async () => {
    const pi = toPiTool(echoTool);
    expect(pi.label).toBe('echo');
    expect(pi.parameters).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string', description: '内容' } },
      required: ['text'],
    });
    const r = await (pi.execute as (id: string, params: unknown) => Promise<{ content: { type: string; text: string }[] }>)(
      't1', { text: 'hi' },
    );
    expect(r.content[0]).toMatchObject({ type: 'text', text: JSON.stringify({ ok: true, data: { echo: 'hi' } }) });
  });

  it('ToolResult ok:false → 抛异常（pi 标 isError 回灌模型）', async () => {
    const pi = toPiTool(echoTool);
    await expect(
      (pi.execute as (id: string, params: unknown) => Promise<unknown>)('t1', {}),
    ).rejects.toThrow('缺少 text');
  });
});

describe('makeBeforeToolCall（单元）', () => {
  it('首个 block 生效并带拦截器名；全放行返回 undefined', async () => {
    const icptA = { name: 'A', check: () => null };
    const icptB = { name: 'B', check: () => ({ block: true, reason: '危险操作' }) };
    const icptC = { name: 'C', check: () => ({ block: true, reason: '不该到这里' }) };
    const before = makeBeforeToolCall([icptA, icptB, icptC]);
    const verdict = await before({ toolCall: { name: 'run_cmd' }, args: { cmd: 'x' } } as never);
    expect(verdict).toMatchObject({ block: true, reason: '[B] 危险操作' });

    const pass = makeBeforeToolCall([icptA]);
    await expect(pass({ toolCall: { name: 'echo' }, args: {} } as never)).resolves.toBeUndefined();
  });
});

describe('安全拦截层（端到端，Faux 脚本）', () => {
  it('被拦工具调用产生 isError toolResult，模型收到 reason 后自纠偏', async () => {
    const dangerous: Tool = {
      name: 'run_cmd',
      description: '执行命令',
      parameters: { cmd: { type: 'string', description: '命令', required: true } },
      async execute(args) {
        return { ok: true, data: { ran: args.cmd } };
      },
    };

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('run_cmd', { cmd: 'rm -rf /' })),
      fauxAssistantMessage(fauxText('已改用安全命令')),
    ]);

    const agent = new Agent({
      initialState: {
        systemPrompt: '你是数字员工', model: faux.getModel(),
        tools: [toPiTool(dangerous)],
      },
      streamFn: models.streamSimple.bind(models),
      beforeToolCall: makeBeforeToolCall([new BashBlacklist()]),
    });

    const toolResults: AgentMessage[] = [];
    agent.subscribe((e) => {
      if (e.type === 'message_end' && (e.message as AgentMessage).role === 'toolResult') {
        toolResults.push(e.message as AgentMessage);
      }
    });

    await agent.prompt('清理磁盘');

    // 第一次调用被拦：isError=true，reason 在结果里，模型可见
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(toolResults[0])).toContain('run_cmd 被安全策略拦截');
    // 第二轮模型继续（自纠偏），循环未终止
    expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(JSON.stringify(agent.state.messages.at(-1))).toContain('已改用安全命令');
  });
});
