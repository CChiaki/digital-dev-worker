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

/**
 * 验证点④：session 持久化与恢复。
 *
 * 关键发现（VERDICT 差异 5）：pi-agent-core 的 AgentHarness 在 0.84.4 是未实现脚手架
 * （prompt 抛 HarnessNotImplemented）；pi-coding-agent 的 AgentSession 可用但依赖其全部
 * 内部服务（SessionManager/ResourceLoader/ModelRuntime），过度耦合。
 * 因此本 spike 验证产品级方案：**裸 Agent + Session 手工接线**（订阅 message_end 落盘，
 * 恢复时从 session 读回 messages 注入 initialState）——胶水层即 P1 的持久化产品层。
 */
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

function makeFaux(script: any[]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(script);
  return { faux, models, model: faux.getModel() };
}

/** 产品层持久化接线（已抽至 helpers/wire-session.ts 供 S5 复用） */
import { wireSession } from './helpers/wire-session.js';

function makeAgent(models: ReturnType<typeof createModels>, model: any, messages?: AgentMessage[]) {
  return new Agent({
    initialState: { systemPrompt: '你是数字员工', model, tools: [echo], ...(messages ? { messages } : {}) },
    streamFn: models.streamSimple.bind(models),
  });
}

describe('Spike4: session 持久化与恢复', () => {
  it('对话经手工接线落盘为 JSONL，含完整 user/assistant/toolResult', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-spike-session-'));
    try {
      const repo = new JsonlSessionRepo({ fs: makeNodeFs(root), sessionsRoot: join(root, 'sessions') });
      const session = await repo.create({ cwd: root });

      const { models, model } = makeFaux([
        fauxAssistantMessage(fauxToolCall('echo', { text: '第一轮工具调用' })),
        fauxAssistantMessage(fauxText('第一轮完成')),
      ]);
      const agent = makeAgent(models, model);
      const unwire = wireSession(agent, session);

      await agent.prompt('调用 echo');
      await unwire();

      const meta = (await repo.list())[0]!;
      const raw = await readFile(meta.path, 'utf8');
      expect(raw).toContain('"role":"user"');
      expect(raw).toContain('"toolResult"');
      expect(raw).toContain('第一轮工具调用');

      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });

  it('恢复：从 session 读回 messages → 注入新 Agent → 上下文完整可继续', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-spike-session-'));
    try {
      const repo = new JsonlSessionRepo({ fs: makeNodeFs(root), sessionsRoot: join(root, 'sessions') });

      // ---- 第一轮 ----
      let firstMeta: Awaited<ReturnType<typeof repo.list>>[number];
      {
        const session = await repo.create({ cwd: root });
        const { models, model } = makeFaux([
          fauxAssistantMessage(fauxToolCall('echo', { text: '恢复测试标记' })),
          fauxAssistantMessage(fauxText('第一轮完成')),
        ]);
        const agent = makeAgent(models, model);
        const unwire = wireSession(agent, session);
        await agent.prompt('调用 echo');
        await unwire();
        firstMeta = (await repo.list())[0]!;
      }

      // ---- 第二轮：新进程视角 ----
      {
        const session = await repo.open(firstMeta!);
        const restored = (await session.findEntries())
          .filter((e) => e.type === 'message')
          .map((e) => (e as any).message as AgentMessage);

        // 上下文完整：user / assistant(带工具调用) / toolResult 都在
        expect(restored.some((m) => m.role === 'user')).toBe(true);
        expect(
          restored.some((m) => m.role === 'toolResult' && JSON.stringify(m).includes('恢复测试标记')),
        ).toBe(true);

        const { models, model } = makeFaux([fauxAssistantMessage(fauxText('第二轮看到上下文了'))]);
        // findEntries 返回 newest-first（按 id 降序），注入前反转为对话时间序
        const agent = makeAgent(models, model, restored.reverse());
        const unwire = wireSession(agent, session);
        await agent.prompt('继续');
        await unwire();

        // 继续对话的落盘包含第一轮 + 新一轮
        const raw = await readFile(firstMeta!.path, 'utf8');
        expect(raw).toContain('恢复测试标记');
        expect(raw).toContain('继续');
      }

      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });

  it('branching：repo.fork 出两个分支，各自追加互不影响', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-spike-session-'));
    try {
      const repo = new JsonlSessionRepo({ fs: makeNodeFs(root), sessionsRoot: join(root, 'sessions') });

      const session = await repo.create({ cwd: root });
      const { models, model } = makeFaux([fauxAssistantMessage(fauxText('原始轮'))]);
      const agent = makeAgent(models, model);
      const unwire = wireSession(agent, session);
      await agent.prompt('原始任务');
      await unwire();

      const meta = (await repo.list())[0]!;
      const branchA = await repo.fork(meta, { cwd: root });
      const branchB = await repo.fork(meta, { cwd: root });

      // 两分支都继承原始 transcript
      for (const b of [branchA, branchB]) {
        const entries = await b.findEntries();
        expect(entries.some((e) => JSON.stringify(e).includes('原始任务'))).toBe(true);
      }

      // 分支 A 追加，分支 B 不受影响
      await branchA.appendMessage({ role: 'user', content: '走 A', timestamp: Date.now() });
      const aEntries = await branchA.findEntries();
      const bEntries = await branchB.findEntries();
      expect(aEntries.some((e) => JSON.stringify(e).includes('走 A'))).toBe(true);
      expect(bEntries.some((e) => JSON.stringify(e).includes('走 A'))).toBe(false);

      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });
});
