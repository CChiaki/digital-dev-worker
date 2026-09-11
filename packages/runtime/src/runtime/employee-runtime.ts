import { randomUUID } from 'node:crypto';
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { AgentEvent, CallType } from '../types.js';
import type { Tool } from '../types.js';
import type { SupervisionPolicy } from '../types.js';
import type { DevTask, PlanItem } from '../task/package.js';
import { createTaskCheckTool, type CheckGate } from '../task/checkpoint.js';
import type { EventBus } from '../events/bus.js';
import type { ModelGateway } from '../model/gateway.js';
import type { ToolRegistry } from '../tools/registry.js';
import { toPiTool } from '../tools/pi-adapter.js';
import { makeBeforeToolCall } from '../security/interceptor.js';
import type { ToolInterceptor } from '../security/types.js';
import type { EmployeeSessionStore } from '../session/employee-session.js';
import { loadMessages } from '../session/employee-session.js';
import { wireSession } from '../session/wire.js';
import { piEventToAgentEvent } from './event-map.js';
import { buildTaskBrief } from '../task/brief.js';
import type { TaskPackage } from '../task/package.js';

export interface EmployeeRuntimeConfig {
  employeeId: string;
  /** 盯梢放权等级（spec 4.4）：run 时留痕进事件流；bash 白名单派生见 resolveBashWhitelist */
  supervision?: SupervisionPolicy;
  /** 人工放行闸门（P10 盯梢闭环）：shadow 级由组装方注入，task_check 申报后阻塞等人工放行 */
  checkGate?: CheckGate;
  /** 任务简报（P2 接入任务包 builder，当前为静态文本） */
  systemPrompt?: string;
  /** 单次任务的轮次上限，超过即优雅退出（session 已实时落盘，可 resume） */
  maxTurns?: number;
}

export interface TaskInput {
  taskId: string;
  instruction: string;
  /** 任务包清单：非空时向 agent 追加任务级 task_check 工具（节点申报，spec 4.4 checkpoint）。
   *  DevTask/PlanItem 均可（工具只消费 id，checkpoint 校验兼容两者） */
  items?: (DevTask | PlanItem)[];
}

/** 计划进度留痕（计划执行器逐项回写） */
export interface PlanProgress {
  itemId: string;
  kind: string;
  title: string;
  status: 'done' | 'failed' | 'skipped';
}

export type EmployeeOutcome =
  | { status: 'done' | 'max_turns' | 'error'; reply: string; turns: number;
      /** 计划模式：逐项进度与停点（无 plan 时缺省） */
      planProgress?: PlanProgress[]; failedItemId?: string;
      /** token 用量汇总（2026-09-11 P2 产品批）：任务全程模型调用累计（输入/输出 tokens、调用次数）。
       *  从 pi message_end(assistant).usage 记账（含无文本的工具调用轮）；无任何调用时缺省 */
      tokenUsage?: { input: number; output: number; calls: number } };

/** Agent 工厂依赖：生产用 createPiAgent（pi 直连），测试注入 Faux 工厂。 */
export type AgentFactory = (opts: {
  systemPrompt: string;
  model: unknown;
  streamFn: StreamFn;
  tools: AgentTool[];
  beforeToolCall?: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  messages?: AgentMessage[];
}) => Agent;

export class EmployeeRuntime {
  private readonly active = new Map<string, Agent>();
  private readonly turns = new Map<string, number>();
  /** token 用量任务账本（2026-09-11 P2 产品批）：runtime 实例生命周期 = 单任务，无泄漏；
   *  计划模式跨项复用同实例，账本跨项累计（末项 outcome 即任务总量） */
  private readonly tokenUsage = new Map<string, { input: number; output: number; calls: number }>();
  private readonly maxTurns: number;
  private readonly callType: CallType;
  private readonly systemPrompt: string;

  constructor(
    private readonly deps: {
      gateway: ModelGateway;
      tools: ToolRegistry;
      interceptors: ToolInterceptor[];
      events: EventBus;
      sessions: EmployeeSessionStore;
      config: EmployeeRuntimeConfig;
      callType?: CallType;
      agentFactory?: AgentFactory;
    },
  ) {
    this.maxTurns = deps.config.maxTurns ?? 40;
    this.callType = deps.callType ?? 'code';
    this.systemPrompt = deps.config.systemPrompt ?? '你是数字员工';
  }

  private async emit(taskId: string, partial: Omit<AgentEvent, 'id' | 'ts' | 'taskId' | 'employeeId'>): Promise<void> {
    await this.deps.events.emit({
      id: randomUUID(), ts: Date.now(), taskId,
      employeeId: this.deps.config.employeeId, ...partial,
    });
  }

  private makeAgent(taskId: string, messages?: AgentMessage[], extraTools: Tool[] = []): Agent {
    const create = this.deps.agentFactory ?? createPiAgent;
    const agent = create({
      systemPrompt: this.systemPrompt,
      model: this.deps.gateway.modelFor(this.callType),
      streamFn: this.deps.gateway.streamFnFor(this.callType),
      tools: [
        ...this.deps.tools.list().map((t) => toPiTool(this.deps.tools.get(t.name)!)),
        ...extraTools.map((t) => toPiTool(t)),
      ],
      beforeToolCall: makeBeforeToolCall(this.deps.interceptors),
      ...(messages ? { messages } : {}),
    });

    // pi 事件 → AgentEvent 映射（直播/审计数据源）
    agent.subscribe((e: any) => {
      // token 用量记账（2026-09-11 P2 产品批）：message_end(assistant).usage 累计入任务账本。
      // 从原始事件记（不经 event-map）——工具调用轮 assistant 消息无文本不产 thinking 事件，
      // 而这类轮次恰是 token 消耗大头，从映射后事件累计会系统性少记
      if (e?.type === 'message_end' && e.message?.role === 'assistant' && e.message?.usage) {
        const u = e.message.usage as { input?: number; output?: number };
        const acc = this.tokenUsage.get(taskId) ?? { input: 0, output: 0, calls: 0 };
        acc.input += u.input ?? 0;
        acc.output += u.output ?? 0;
        acc.calls += 1;
        this.tokenUsage.set(taskId, acc);
      }
      const mapped = piEventToAgentEvent(e, taskId, this.deps.config.employeeId);
      if (mapped) void this.deps.events.emit(mapped);
    });

    // maxTurns：每轮计数，达到上限优雅退出（P0 实测 shouldStopAfterTurn 返回 true 即 agent_end）
    let turns = 0;
    agent.shouldStopAfterTurn = async () => {
      turns++;
      this.turns.set(taskId, turns);
      return turns >= this.maxTurns;
    };
    return agent;
  }

  /** 执行任务：建 Agent → wireSession 落盘 → prompt。任务运行中可 steer。 */
  async run(task: TaskInput): Promise<EmployeeOutcome> {
    // 盯梢等级留痕（spec 4.4：事后审计可查任务执行时的放权等级）
    await this.emit(task.taskId, {
      type: 'report',
      summary: `盯梢级别: ${this.deps.config.supervision?.level ?? 'shadow'}`,
      payload: { supervision: this.deps.config.supervision ?? { level: 'shadow' } },
    });
    // 任务级工具：清单非空时注入 task_check（节点申报，事件走 runtime emit 通道；
    // shadow 级带人工放行闸门——申报后阻塞等待，P10 盯梢闭环）
    const extraTools = task.items?.length
      ? createTaskCheckTool({ emit: (e) => this.emit(task.taskId, e), items: task.items, ...(this.deps.config.checkGate ? { gate: this.deps.config.checkGate } : {}) })
      : [];
    const agent = this.makeAgent(task.taskId, undefined, extraTools);
    const session = await this.deps.sessions.open(task.taskId);
    const stop = wireSession(agent, session);
    this.active.set(task.taskId, agent);
    try {
      await agent.prompt(task.instruction);
    } catch (err) {
      await this.emit(task.taskId, {
        type: 'error',
        summary: `任务执行失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    } finally {
      await stop();
      this.active.delete(task.taskId);
    }
    return this.finish(task.taskId, agent);
  }

  /** 任务包便捷入口：任务包 → 任务简报 → run（简报作为首条任务指令进入上下文；清单透传以启用节点申报） */
  async runTaskPackage(pkg: TaskPackage): Promise<EmployeeOutcome> {
    return this.run({ taskId: pkg.taskId, instruction: buildTaskBrief(pkg), items: pkg.tasks });
  }

  /** 从 session 恢复并下发自定义指令（计划执行器逐项驱动：同会话上下文延续）。 */
  async resumeWith(taskId: string, instruction: string, extraTools: Tool[] = []): Promise<EmployeeOutcome> {
    const session = await this.deps.sessions.open(taskId);
    const messages = await loadMessages(session);
    const agent = this.makeAgent(taskId, messages, extraTools);
    const stop = wireSession(agent, session);
    this.active.set(taskId, agent);
    try {
      await agent.prompt(instruction);
    } finally {
      await stop();
      this.active.delete(taskId);
    }
    return this.finish(taskId, agent);
  }

  /** 从 session 恢复继续（P0-S4 已验证：loadMessages 时间序注入 initialState.messages） */
  async resume(taskId: string): Promise<EmployeeOutcome> {
    return this.resumeWith(taskId, '继续完成任务并汇报结果');
  }

  /** 介入通道：运行中注入消息进入上下文 + intervention 审计留痕。返回 false=任务不在运行中。 */
  steer(taskId: string, message: string): boolean {
    const agent = this.active.get(taskId);
    if (!agent) return false;
    agent.steer({
      role: 'user',
      content: [{ type: 'text', text: message }],
      timestamp: Date.now(),
    } as AgentMessage);
    void this.emit(taskId, { type: 'intervention', summary: message.slice(0, 200) });
    return true;
  }

  private collect(taskId: string, agent: Agent): EmployeeOutcome {
    const last = agent.state.messages.at(-1);
    // 模型失败收尾检测（2026-09-11 事故修复）：pi 对模型 4xx/断流不抛异常，而是落一条
    // stopReason='error'/'aborted' 的空 assistant 消息后正常结束循环——此前 collect 只认
    // maxTurns，错误收尾被标 done(空 reply)。真实事故：grep 命中 minified 产物把上下文撑爆
    // （400 input_tokens 超限）后，计划后续项在同样坏掉的 session 上逐项「秒完成」——5 项全
    // 假 done、0 实际动作、0 人工节点。错误收尾必须显式失败，让调度器/计划执行器走失败链路
    const lastAssistant =
      last?.role === 'assistant' ? (last as { stopReason?: string; errorMessage?: string }) : undefined;
    const reply =
      last?.role === 'assistant'
        ? (last.content as { type: string; text?: string }[])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('')
        : '';
    const turns = this.turns.get(taskId) ?? 0;
    const tokenUsage = this.tokenUsage.get(taskId);
    if (lastAssistant?.errorMessage || lastAssistant?.stopReason === 'error' || lastAssistant?.stopReason === 'aborted') {
      return {
        status: 'error',
        reply: `模型调用失败: ${(lastAssistant.errorMessage ?? `stopReason=${lastAssistant.stopReason}`).slice(0, 500)}`,
        turns,
        ...(tokenUsage ? { tokenUsage } : {}),
      };
    }
    return {
      status: turns >= this.maxTurns ? 'max_turns' : 'done',
      reply, turns,
      ...(tokenUsage ? { tokenUsage } : {}),
    };
  }

  /** 收尾（2026-09-11 P2 产品批）：outcome 携带 token 用量，并写 report 事件留痕（成本可见性——
   *  计划模式每项收尾各留一条累计快照，末项即任务总量；用量为零不产生事件不污染审计流） */
  private async finish(taskId: string, agent: Agent): Promise<EmployeeOutcome> {
    const outcome = this.collect(taskId, agent);
    if (outcome.tokenUsage && (outcome.tokenUsage.input > 0 || outcome.tokenUsage.output > 0)) {
      await this.emit(taskId, {
        type: 'report',
        summary: `Token 用量：输入 ${outcome.tokenUsage.input.toLocaleString()} / 输出 ${outcome.tokenUsage.output.toLocaleString()}（${outcome.tokenUsage.calls} 次模型调用）`,
        payload: { tokenUsage: outcome.tokenUsage },
      });
    }
    return outcome;
  }
}

/** 生产 Agent 工厂（pi 直连行内模型） */
export function createPiAgent(opts: Parameters<AgentFactory>[0]): Agent {
  return new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: opts.model as never,
      tools: opts.tools,
      ...(opts.messages ? { messages: opts.messages } : {}),
    },
    streamFn: opts.streamFn,
    ...(opts.beforeToolCall ? { beforeToolCall: opts.beforeToolCall } : {}),
  });
}
