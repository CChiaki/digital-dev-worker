import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type AgentMessage, type AgentTool, type BeforeToolCallContext, type BeforeToolCallResult, type StreamFn } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { EmployeeRuntime, type AgentFactory } from '../src/runtime/employee-runtime.js';
import { ModelGateway } from '../src/model/gateway.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { EmployeeSessionStore, loadMessages } from '../src/session/employee-session.js';
import { EventBus } from '../src/events/bus.js';
import { BashBlacklist } from '../src/security/bash-blacklist.js';
import type { Tool, AgentEvent, ModelSpec, RouteConfig } from '../src/types.js';

const spec = (name: string): ModelSpec => ({
  name, baseUrl: 'http://model.local/v1', apiKey: 'k', model: name,
});
const routes: RouteConfig[] = [{ callType: 'code', primary: spec('qwen3.8-27b') }];

/** 测试用 Faux Agent 工厂：脚本步骤 { toolCall } 或 { text } */
function makeFauxFactory(
  script: Array<{ toolCall?: { name: string; arguments: Record<string, unknown> }; text?: string }>,
): AgentFactory {
  return (opts) => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(
      script.map((s) =>
        s.toolCall
          ? fauxAssistantMessage(fauxToolCall(s.toolCall.name, s.toolCall.arguments))
          : fauxAssistantMessage(fauxText(s.text!)),
      ),
    );
    return new Agent({
      initialState: {
        systemPrompt: opts.systemPrompt,
        model: faux.getModel(),
        tools: opts.tools,
        ...(opts.messages ? { messages: opts.messages } : {}),
      },
      streamFn: models.streamSimple.bind(models),
      ...(opts.beforeToolCall ? { beforeToolCall: opts.beforeToolCall } : {}),
    });
  };
  void ({} as { streamFn?: StreamFn });
}

function makeEcho(delayMs = 0): Tool {
  return {
    name: 'echo',
    description: '回声',
    parameters: { text: { type: 'string', description: '内容', required: true } },
    async execute(args) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { ok: true, data: { echo: args.text } };
    },
  };
}

function makeRt(root: string, opts: {
  script: Parameters<typeof makeFauxFactory>[0];
  maxTurns?: number;
  events?: EventBus;
  tool?: Tool;
}) {
  const events = opts.events ?? new EventBus();
  const tools = new ToolRegistry();
  tools.register(opts.tool ?? makeEcho());
  return new EmployeeRuntime({
    gateway: new ModelGateway(routes),
    tools,
    interceptors: [new BashBlacklist()],
    events,
    sessions: new EmployeeSessionStore(root),
    config: { employeeId: 'emp-01', maxTurns: opts.maxTurns },
    agentFactory: makeFauxFactory(opts.script),
  });
}

describe('EmployeeRuntime', () => {
  it('端到端：任务→工具调用→完成，事件流+session落盘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-rt-'));
    try {
      const events = new EventBus();
      const received: AgentEvent[] = [];
      events.on('event', (e) => received.push(e));

      const rt = makeRt(root, {
        script: [
          { toolCall: { name: 'echo', arguments: { text: 'hi' } } },
          { text: '完成了' },
        ],
        events,
      });

      const outcome = await rt.run({ taskId: 'T1', instruction: '干完这个活' });

      // token 用量随 outcome 汇总（2026-09-11 P2 产品批：faux 估算值非确定，只验结构与单调性）
      expect(outcome).toMatchObject({ status: 'done', reply: '完成了', turns: 2 });
      expect(outcome.tokenUsage).toMatchObject({ calls: 2 });
      expect(outcome.tokenUsage!.input).toBeGreaterThan(0);
      // 首条为盯梢等级留痕（spec 4.4），随后是工具与思考事件；末条为 token 用量 report 留痕
      expect(received.map((e) => e.type)).toEqual(['report', 'tool_call', 'thinking', 'report']);
      expect(received[0]).toMatchObject({ taskId: 'T1', employeeId: 'emp-01', summary: '盯梢级别: shadow' });
      expect(received[1]).toMatchObject({ taskId: 'T1', employeeId: 'emp-01', summary: 'echo' });
      expect(received.at(-1)?.payload).toMatchObject({ tokenUsage: outcome.tokenUsage });

      // session 已落盘且含完整链路
      const msgs = await loadMessages(await new EmployeeSessionStore(root).open('T1'));
      expect(msgs[0].role).toBe('user');
      expect(msgs.some((m) => m.role === 'toolResult')).toBe(true);
      expect(msgs.some((m) => JSON.stringify(m).includes('完成了'))).toBe(true);
      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });

  it('max_turns 耗尽返回 max_turns，新 runtime 从 session resume 到 done', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-rt2-'));
    try {
      const rt1 = makeRt(root, {
        script: [
          { toolCall: { name: 'echo', arguments: { text: 'a' } } },
          { toolCall: { name: 'echo', arguments: { text: 'b' } } },
          { toolCall: { name: 'echo', arguments: { text: 'c' } } },
        ],
        maxTurns: 2,
      });
      const o1 = await rt1.run({ taskId: 'T2', instruction: '一直调' });
      expect(o1.status).toBe('max_turns');
      expect(o1.turns).toBe(2);

      // 第二个实例（模拟进程重启）：恢复后模型给最终回答
      const rt2 = makeRt(root, { script: [{ text: '恢复后完成' }] });
      const o2 = await rt2.resume('T2');
      expect(o2.status).toBe('done');
      expect(o2.reply).toBe('恢复后完成');

      // resume 后 transcript 完整：旧消息 + 恢复轮
      const msgs = await loadMessages(await new EmployeeSessionStore(root).open('T2'));
      expect(msgs.some((m) => JSON.stringify(m).includes('恢复后完成'))).toBe(true);
      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });

  it('steer：运行中介入消息进入上下文并留痕 intervention 事件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-rt3-'));
    try {
      const events = new EventBus();
      const received: AgentEvent[] = [];
      events.on('event', (e) => received.push(e));

      const rt = makeRt(root, {
        script: [
          { toolCall: { name: 'echo', arguments: { text: '慢活' } } },
          { text: '收到指示，已调整' },
        ],
        events,
        tool: makeEcho(80), // 慢工具：给 steer 留窗口
      });

      const run = rt.run({ taskId: 'T3', instruction: '开始任务' });
      await new Promise((r) => setTimeout(r, 30));
      expect(rt.steer('T3', '注意：需求有变更，按新规范来')).toBe(true);
      const outcome = await run;

      expect(outcome.status).toBe('done');
      // intervention 事件已发（审计留痕）
      expect(received.some((e) => e.type === 'intervention')).toBe(true);
      // steer 注入的消息进入会话
      const msgs = await loadMessages(await new EmployeeSessionStore(root).open('T3'));
      expect(msgs.some((m) => JSON.stringify(m).includes('需求有变更'))).toBe(true);
      // 不在运行中时 steer 返回 false
      expect(rt.steer('T3', '再补一条')).toBe(false);
      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });

  it('resumeWith：延续 session 上下文并执行自定义指令（计划执行器逐项驱动基础）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-rt5-'));
    try {
      // 记录每次 agent 创建时收到的 messages / tools，校验历史上下文与 extraTools 透传
      const created: { messages?: AgentMessage[]; toolNames: string[] }[] = [];
      const factory: AgentFactory = (opts) => {
        created.push({ messages: opts.messages, toolNames: opts.tools.map((t) => t.name) });
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        faux.setResponses([fauxAssistantMessage(fauxText('本项完成'))]);
        return new Agent({
          initialState: {
            systemPrompt: opts.systemPrompt,
            model: faux.getModel(),
            tools: opts.tools,
            ...(opts.messages ? { messages: opts.messages } : {}),
          },
          streamFn: models.streamSimple.bind(models),
        });
      };
      const tools = new ToolRegistry();
      tools.register(makeEcho());
      const rt = new EmployeeRuntime({
        gateway: new ModelGateway(routes),
        tools,
        interceptors: [new BashBlacklist()],
        events: new EventBus(),
        sessions: new EmployeeSessionStore(root),
        config: { employeeId: 'emp-01' },
        agentFactory: factory,
      });

      await rt.run({ taskId: 't-plan', instruction: '第一项：开发' });
      const probe: Tool = {
        name: 'plan_probe',
        description: '探针',
        parameters: {},
        async execute() {
          return { ok: true, data: {} };
        },
      };
      const out = await rt.resumeWith('t-plan', '第二项：测试（应能看到第一项产出）', [probe]);
      expect(out.status).toBe('done');

      // 第二次调用带历史上下文：首条指令在 initialState.messages 里
      expect(JSON.stringify(created[1]!.messages)).toContain('第一项：开发');
      // session 落盘完整：第一项与自定义指令都在 transcript
      const msgs = await loadMessages(await new EmployeeSessionStore(root).open('t-plan'));
      expect(msgs.some((m) => JSON.stringify(m).includes('第一项：开发'))).toBe(true);
      expect(msgs.some((m) => JSON.stringify(m).includes('第二项：测试'))).toBe(true);
      // extraTools 透传到 agent
      expect(created[1]!.toolNames).toContain('plan_probe');
      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });

  it('安全拦截集成：被拦调用留痕 isError tool_call 事件，模型自纠偏后完成', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-rt4-'));
    try {
      const dangerous: Tool = {
        name: 'run_cmd',
        description: '执行命令',
        parameters: { cmd: { type: 'string', description: '命令', required: true } },
        async execute(args) {
          return { ok: true, data: { ran: args.cmd } };
        },
      };
      const events = new EventBus();
      const received: AgentEvent[] = [];
      events.on('event', (e) => received.push(e));

      const tools = new ToolRegistry();
      tools.register(dangerous);
      const rt = new EmployeeRuntime({
        gateway: new ModelGateway(routes),
        tools,
        interceptors: [new BashBlacklist()],
        events,
        sessions: new EmployeeSessionStore(root),
        config: { employeeId: 'emp-01' },
        agentFactory: makeFauxFactory([
          { toolCall: { name: 'run_cmd', arguments: { cmd: 'sudo rm -rf /' } } },
          { text: '已改用安全方式' },
        ]),
      });

      const outcome = await rt.run({ taskId: 'T4', instruction: '清理磁盘' });
      expect(outcome.status).toBe('done');
      const toolEvent = received.find((e) => e.type === 'tool_call')!;
      expect(toolEvent.payload).toMatchObject({ isError: true });
      expect(JSON.stringify(toolEvent.payload)).toContain('安全策略拦截');
      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });
  it('token 用量记账（2026-09-11 P2 产品批）：工具调用轮（无文本）同样入账；resumeWith 跨次累计', async () => {    const root = await mkdtemp(join(tmpdir(), 'ddw-rt-usage-'));
    try {
      const events = new EventBus();
      const reports: AgentEvent[] = [];
      events.on('event', (e) => { if (e.type === 'report') reports.push(e); });
      // 第一段：纯工具调用轮（assistant 无文本——event-map 不产 thinking 事件，记账必须仍生效）
      const rt = makeRt(root, {
        script: [{ toolCall: { name: 'echo', arguments: { text: 'a' } } }, { text: '第一项完成' }],
        events,
      });
      const first = await rt.run({ taskId: 'T-U', instruction: '第一项' });
      expect(first.tokenUsage).toMatchObject({ calls: 2 });
      expect(first.tokenUsage!.input).toBeGreaterThan(0);

      // 第二段：resumeWith 延续同任务（计划执行器逐项语义）——账本跨次累计而非清零
      const rt2 = makeRt(root, {
        script: [{ toolCall: { name: 'echo', arguments: { text: 'b' } } }, { text: '第二项完成' }],
        events,
      });
      const second = await rt2.resumeWith('T-U', '第二项');
      expect(second.tokenUsage!.calls).toBeGreaterThanOrEqual(first.tokenUsage!.calls);
      expect(second.tokenUsage!.input).toBeGreaterThanOrEqual(first.tokenUsage!.input);

      // 用量 report 留痕进事件流（每段收尾一条，payload 带累计账本）
      const usageReports = reports.filter((e) => 'tokenUsage' in ((e.payload ?? {}) as Record<string, unknown>));
      expect(usageReports).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 2026-09-11 事故修复：pi 对模型 4xx（如上下文超限）不抛异常，而是落一条 stopReason='error'
  // 的空 assistant 消息后正常结束循环——此前 collect 只认 maxTurns，错误收尾被标 done(空 reply)，
  // 计划后续项在坏掉的 session 上逐项「秒完成」（真实事故：5 项全假 done、0 实际动作、0 人工节点）
  it('模型错误收尾映射 error outcome（不再假 done）：stopReason=error/aborted 均显式失败', async () => {
    const root2 = await mkdtemp(join(tmpdir(), 'ddw-rt-err-'));
    try {
      // stub agent：prompt 时模拟 pi 400 收尾——不抛异常，落 stopReason=error 空消息
      const errAgentFactory: AgentFactory = () => {
        const agent: Record<string, unknown> = {
          subscribe: () => () => {},
          steer: () => false,
          state: { messages: [] as unknown[] },
          prompt: async () => {
            (agent.state as { messages: unknown[] }).messages.push({
              role: 'assistant', content: [], stopReason: 'error',
              errorMessage: '400: This model\'s maximum context length is 262144 tokens.',
            });
          },
        };
        return agent as never;
      };
      const tools = new ToolRegistry();
      tools.register(makeEcho());
      const rt = new EmployeeRuntime({
        gateway: new ModelGateway(routes),
        tools,
        interceptors: [new BashBlacklist()],
        events: new EventBus(),
        sessions: new EmployeeSessionStore(root2),
        config: { employeeId: 'emp-01' },
        agentFactory: errAgentFactory,
      });
      const out = await rt.run({ taskId: 'T-ERR', instruction: '干个会炸的活' });
      expect(out.status).toBe('error');
      expect(out.reply).toContain('模型调用失败');
      expect(out.reply).toContain('maximum context length');

      // aborted 同理：中断收尾不得标 done
      const rt2 = new EmployeeRuntime({
        gateway: new ModelGateway(routes),
        tools,
        interceptors: [new BashBlacklist()],
        events: new EventBus(),
        sessions: new EmployeeSessionStore(root2),
        config: { employeeId: 'emp-01' },
        agentFactory: () =>
          ({
            subscribe: () => () => {},
            steer: () => false,
            state: { messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }] },
            prompt: async () => {},
          }) as never,
      });
      const out2 = await rt2.run({ taskId: 'T-ABORT', instruction: 'x' });
      expect(out2.status).toBe('error');
      expect(out2.reply).toContain('stopReason=aborted');

      // 正常收尾（最后一条非 assistant / 无错误标记）不受影响：faux 常规脚本仍 done
      const rt3 = makeRt(root2, { script: [{ text: '正常完成' }] });
      const out3 = await rt3.run({ taskId: 'T-OK', instruction: 'x' });
      expect(out3.status).toBe('done');
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });
});
