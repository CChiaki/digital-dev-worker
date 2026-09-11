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
 * 模拟我们要自研的安全拦截层核心逻辑（spec 4.6：工程期白名单 + 运行期拦截）
 */
const BLOCKED_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /rm\s+-rf/, reason: '禁止递归强制删除' },
  { re: /curl\s+http/, reason: '禁止命令行访问网络（网络操作走 MCP 网关）' },
  { re: /kill\s+-9/, reason: '禁止杀死进程' },
];

export function interceptCommand(cmd: string): { allowed: boolean; reason?: string } {
  for (const p of BLOCKED_PATTERNS) {
    if (p.re.test(cmd)) return { allowed: false, reason: p.reason };
  }
  return { allowed: true };
}

/** 供本测试与后续 spike 复用的 bash 工具 */
export function makeBashTool(executed: string[]): AgentTool<{ command: string }, string> {
  return {
    name: 'bash',
    label: 'Shell',
    description: '执行 shell 命令',
    parameters: Type.Object({ command: Type.String({ description: '命令' }) }),
    execute: async (_id, params) => {
      executed.push(params.command);
      return { content: [{ type: 'text', text: `ran: ${params.command}` }], details: params.command };
    },
  };
}

/** 建一个带拦截钩子的 Agent（后续 spike 复用） */
export function makeInterceptedAgent(bashTool: AgentTool<{ command: string }, string>) {
  const blocked: Array<{ command: string; reason: string }> = [];

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const agent = new Agent({
    initialState: { systemPrompt: '你是数字员工', model: faux.getModel(), tools: [bashTool] },
    streamFn: models.streamSimple.bind(models),
    beforeToolCall: async (ctx) => {
      if (ctx.toolCall.name === 'bash') {
        const cmd = (ctx.args as { command: string }).command;
        const r = interceptCommand(cmd);
        if (!r.allowed) {
          blocked.push({ command: cmd, reason: r.reason! });
          return { block: true, reason: r.reason };
        }
      }
      return undefined;
    },
  });

  return { agent, faux, models, blocked };
}

describe('Spike2: beforeToolCall 拦截层', () => {
  it('拦截逻辑单元：黑名单命中/放行', () => {
    expect(interceptCommand('rm -rf /workspace')).toEqual({ allowed: false, reason: '禁止递归强制删除' });
    expect(interceptCommand('curl http://evil.local')).toEqual({
      allowed: false,
      reason: '禁止命令行访问网络（网络操作走 MCP 网关）',
    });
    expect(interceptCommand('npm test')).toEqual({ allowed: true });
  });

  it('集成：黑名单命令被 beforeToolCall 阻止，未真实执行，原因以 toolResult 回到模型', async () => {
    const executed: string[] = [];
    const { agent, faux, blocked } = makeInterceptedAgent(makeBashTool(executed));

    // 脚本：第一轮尝试 rm -rf；第二轮模型感知被拦原因后改用安全命令；第三轮收尾
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: 'rm -rf /workspace' })),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'npm test' })),
      fauxAssistantMessage(fauxText('已改用安全命令完成')),
    ]);

    await agent.prompt('清理工作区并跑测试');

    // ① 黑名单命令没有进入 execute
    expect(executed).toEqual(['npm test']);

    // ② 拦截记录
    expect(blocked).toEqual([{ command: 'rm -rf /workspace', reason: '禁止递归强制删除' }]);

    // ③ 被拦原因以 toolResult 回到模型（模型下一轮能纠偏）
    const toolResults = agent.state.messages.filter((m) => m.role === 'toolResult');
    const blockedResult = toolResults.find((m) => JSON.stringify(m).includes('禁止递归强制删除'));
    expect(blockedResult).toBeDefined();
  });
});
