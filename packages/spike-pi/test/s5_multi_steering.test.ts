import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, JsonlSessionRepo, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import { createModels, Type } from '@earendil-works/pi-ai';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from '@earendil-works/pi-ai/providers/faux';
import { makeNodeFs } from './helpers/node-fs.js';
import { wireSession } from './helpers/wire-session.js';

const echo: AgentTool<{ text: string }, { text: string }> = {
  name: 'echo',
  label: '回声',
  description: '回声工具',
  parameters: Type.Object({ text: Type.String() }),
  execute: async (_id, params) => ({
    content: [{ type: 'text', text: JSON.stringify({ echo: params.text }) }],
    details: params,
  }),
};

function makeAgent(model: any, tools: AgentTool<any, any>[], messages?: AgentMessage[]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = new Agent({
    initialState: { systemPrompt: '你是数字员工', model, tools, ...(messages ? { messages } : {}) },
    streamFn: models.streamSimple.bind(models),
  });
  return { faux, agent };
}

describe('Spike5: 单进程多实例', () => {
  it('同一进程两个 Agent 并行运行，各自 transcript 独立落盘互不串扰', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-spike-multi-'));
    try {
      const repo = new JsonlSessionRepo({ fs: makeNodeFs(root), sessionsRoot: join(root, 'sessions') });
      const s1 = await repo.create({ cwd: root });
      const s2 = await repo.create({ cwd: root });

      const m1 = fauxProvider().getModel();
      const m2 = fauxProvider().getModel();
      const a1 = makeAgent(m1, [echo]);
      const a2 = makeAgent(m2, [echo]);
      a1.faux.setResponses([fauxAssistantMessage(fauxText('甲完成了'))]);
      a2.faux.setResponses([fauxAssistantMessage(fauxToolCall('echo', { text: '乙干活' })), fauxAssistantMessage(fauxText('乙完成了'))]);

      const stop1 = wireSession(a1.agent, s1);
      const stop2 = wireSession(a2.agent, s2);

      await Promise.all([
        a1.agent.prompt('任务甲'),
        a2.agent.prompt('任务乙'),
      ]);
      await stop1();
      await stop2();

      // 最终状态各自正确
      const msgs1 = a1.agent.state.messages;
      const msgs2 = a2.agent.state.messages;
      expect(JSON.stringify(msgs1)).toContain('任务甲');
      expect(JSON.stringify(msgs1)).toContain('甲完成了');
      expect(JSON.stringify(msgs1)).not.toContain('乙');
      expect(JSON.stringify(msgs2)).toContain('乙完成了');
      expect(JSON.stringify(msgs2)).toContain('toolResult');
      expect(JSON.stringify(msgs2)).not.toContain('甲完成了');

      // 落盘为两个独立 session 文件
      const metas = await repo.list();
      expect(metas.length).toBe(2);
      const raws = await Promise.all(metas.map((m) => readFile(m.path, 'utf8')));
      expect(raws.some((r) => r.includes('甲完成了'))).toBe(true);
      expect(raws.some((r) => r.includes('乙完成了') && r.includes('toolResult'))).toBe(true);
      expect(raws.every((r) => !(r.includes('甲完成了') && r.includes('乙完成了')))).toBe(true);

      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });
});

describe('Spike7: steering 运行中介入', () => {
  it('agent.steer() 在运行中注入消息，下一轮进入模型上下文', async () => {
    // echo 加延迟，保证 steer() 在工具执行期间（运行中）到达
    const slowEcho: AgentTool<{ text: string }, { text: string }> = {
      name: 'echo',
      label: '慢回声',
      description: '回声工具',
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_id, params) => {
        await new Promise((r) => setTimeout(r, 80));
        return { content: [{ type: 'text', text: JSON.stringify({ echo: params.text }) }], details: params };
      },
    };

    const { faux, agent } = makeAgent(fauxProvider().getModel(), [slowEcho]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('echo', { text: '第一轮工具' })),
      // 第二轮：模型应已看到 steer 注入的用户消息
      fauxAssistantMessage(fauxText('收到指示，已调整')),
    ]);

    const events: string[] = [];
    agent.subscribe((e) => events.push(e.type));

    const run = agent.prompt('开始任务');
    // 工具执行（80ms）期间介入
    await new Promise((r) => setTimeout(r, 30));
    const steerMsg: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: '注意：需求有变更，按新规范来' }],
      timestamp: Date.now(),
    };
    agent.steer(steerMsg);
    await run;

    // 注入消息进入对话上下文（工具结果之后、最终回复之前）
    const msgs = agent.state.messages;
    const steerIdx = msgs.findIndex((m) => JSON.stringify(m).includes('需求有变更'));
    const toolResultIdx = msgs.findIndex((m) => m.role === 'toolResult');
    const finalIdx = msgs.findIndex((m) => m.role === 'assistant' && JSON.stringify(m).includes('收到指示'));
    expect(steerIdx).toBeGreaterThan(toolResultIdx);
    expect(finalIdx).toBeGreaterThan(steerIdx);

    // 生命周期完整：steer 触发了额外一轮（3 个 turn_end：工具轮 + steer 后轮…至少两轮）
    expect(events.filter((e) => e === 'turn_end').length).toBeGreaterThanOrEqual(2);
    expect(events[events.length - 1]).toBe('agent_end');
  });
});
