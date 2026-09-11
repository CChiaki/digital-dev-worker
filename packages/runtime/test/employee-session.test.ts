import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels, Type } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { EmployeeSessionStore, loadMessages } from '../src/session/employee-session.js';
import { wireSession } from '../src/session/wire.js';

const echo = {
  name: 'echo', label: 'echo', description: '回声',
  parameters: Type.Object({ text: Type.String() }),
  execute: async (_id: string, p: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(p) }], details: p,
  }),
};

function makeAgent(model: any) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('echo', { text: '干活标记' })),
    fauxAssistantMessage(fauxText('完成')),
  ]);
  return new Agent({
    initialState: { systemPrompt: 's', model, tools: [echo] },
    streamFn: models.streamSimple.bind(models),
  });
}

describe('EmployeeSessionStore', () => {
  it('open 幂等：同 taskId 得到同一 session；transcript 完整落盘（时间序）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-sess-'));
    try {
      const store = new EmployeeSessionStore(root);
      const s1 = await store.open('T1');
      const agent = makeAgent(fauxProvider().getModel());
      const stop = wireSession(agent, s1);
      await agent.prompt('开始任务');
      await stop();

      // 幂等：再次 open 返回同一份 transcript
      const s2 = await store.open('T1');
      const msgs = await loadMessages(s2);
      expect(msgs.some((m) => JSON.stringify(m).includes('干活标记'))).toBe(true);
      expect(msgs.some((m) => m.role === 'toolResult')).toBe(true);
      expect(msgs[0].role).toBe('user'); // reverse 后时间序

      // 磁盘上确实有 JSONL（该任务的 sessions 目录有文件）
      const files = await readdir(join(root, 'sessions'));
      expect(files.length).toBe(1);
      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });

  it('不同 taskId 互不串扰', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-sess-'));
    try {
      const store = new EmployeeSessionStore(root);
      const sA = await store.open('TASK-A');
      const sB = await store.open('TASK-B');
      await sA.appendMessage({
        role: 'user', content: [{ type: 'text', text: 'A 的消息' }], timestamp: Date.now(),
      } as never);
      const msgsB = await loadMessages(sB);
      expect(msgsB.some((m) => JSON.stringify(m).includes('A 的消息'))).toBe(false);
      const msgsA = await loadMessages(sA);
      expect(msgsA.some((m) => JSON.stringify(m).includes('A 的消息'))).toBe(true);
      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });

  it('remove：删除该任务的 session（重跑清残留）；无 session 时幂等 no-op（2026-09-06 任务重跑清空）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-sess-rm-'));
    try {
      const store = new EmployeeSessionStore(root);
      const s = await store.open('TASK-R');
      await s.appendMessage({
        role: 'user', content: [{ type: 'text', text: '旧上下文' }], timestamp: Date.now(),
      } as never);

      await store.remove('TASK-R');
      await store.remove('TASK-R'); // 幂等：再删一次不抛

      // 重新 open 得到全新 session：旧消息不在
      const fresh = await store.open('TASK-R');
      expect(await loadMessages(fresh)).toEqual([]);

      // 其他任务不受牵连
      const other = await store.open('TASK-OTHER');
      await other.appendMessage({
        role: 'user', content: [{ type: 'text', text: '别的任务' }], timestamp: Date.now(),
      } as never);
      await store.remove('TASK-R');
      expect((await loadMessages(other)).some((m) => JSON.stringify(m).includes('别的任务'))).toBe(true);
      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });
});
