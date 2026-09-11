import type { EventFilter, EventStore } from '../stores/index.js';

export interface SseRes {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(): unknown;
}

export interface SseRequest {
  path: string;
  query?: Record<string, string>;
}

export interface SseOptions {
  intervalMs?: number;
  maxDurationMs?: number;
  /** 每轮轮询前检查；返回 false 立即结束（生产 server 用它感知客户端断开） */
  shouldContinue?: () => boolean;
}

/** SSE 空闲心跳间隔：小于常见反代 read_timeout（本机 httpserver 为 30s），防空闲连接被掐 */
const KEEPALIVE_MS = 15_000;
const KEEPALIVE_CHUNK = ': keepalive\n\n';

/**
 * SSE 直播 handler（注入式 res，测试不监听端口）：
 * text/event-stream 增量推送 AgentEvent（since 语义与 /api/events 相同，ts >= since）。
 * 断开/超时自动结束；客户端重连带着最后事件 ts 即无缝续播。
 */
export function createSseHandler(events: EventStore, opts: SseOptions = {}): (req: SseRequest, res: SseRes) => Promise<void> {
  const intervalMs = opts.intervalMs ?? 1_000;
  const maxDurationMs = opts.maxDurationMs ?? 10 * 60_000;

  return async (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // nginx 系反代（本机 httpserver）默认缓冲 upstream 响应，SSE 帧会被攒着不到达；
      // 此头让代理对该响应关闭缓冲（X-Accel-Buffering 标准语义，非 nginx 环境无害）
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    let lastWrite = Date.now();

    const filter: EventFilter = {};
    if (req.query?.taskId) filter.taskId = req.query.taskId;
    if (req.query?.employeeId) filter.employeeId = req.query.employeeId;

    let since = req.query?.since !== undefined ? Number(req.query.since) : undefined;
    const pushed = new Set<string>(); // at-least-once 去重：list 语义为 ts >= since，已推帧不重复推
    const deadline = Date.now() + maxDurationMs;

    while (Date.now() < deadline && (opts.shouldContinue?.() ?? true)) {
      const fresh = await events.list({ ...filter, since });
      for (const e of fresh) {
        if (pushed.has(e.id)) continue;
        pushed.add(e.id);
        res.write(`event: agent-event\ndata: ${JSON.stringify(e)}\n\n`);
        since = e.ts;
        lastWrite = Date.now();
      }
      // 空闲心跳：无事件也要让字节流过代理，否则 read_timeout 到点掐连接（重连风暴）
      if (Date.now() - lastWrite >= KEEPALIVE_MS) {
        res.write(KEEPALIVE_CHUNK); // 冒号开头是 SSE 注释帧，客户端忽略
        lastWrite = Date.now();
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    res.end();
  };
}

/** 实时角标计数（2026-09-10 消息中心推送改造）：unread 消息未读 / checksPending 待放行 / skillsPending Skill 待审查 */
export interface LiveCounts {
  unread: number;
  checksPending: number;
  skillsPending: number;
}

/** 实时总线事件：message = 新落库消息（推送进消息中心）；counts = 计数可能已变（重算推送） */
export type LiveEvent = { kind: 'message'; message: unknown } | { kind: 'counts' };

/**
 * 实时推送 SSE handler（/api/messages/stream，2026-09-10 用户需求：消息改推送不轮询）：
 * - counts 事件：连接建立即推一次；此后每个总线事件（新消息/已读/放行/Skill 终审）重算——
 *   有变化才推；另有周期对账（默认 60s）兜底丢帧。
 * - message 事件：新消息落库即推给所有连接（前端弹通知）。
 * 前端用原生 EventSource（自动重连），重连后 counts 快照自愈。
 */
export function createLiveSseHandler(deps: {
  subscribe: (fn: (e: LiveEvent) => void) => () => void;
  counts: () => Promise<LiveCounts>;
  /** 周期对账间隔（兜底，缺省 60s）——推送主链路是总线事件，这不是轮询替代 */
  reconcileMs?: number;
  maxDurationMs?: number;
  shouldContinue?: () => boolean;
}): (req: SseRequest, res: SseRes) => Promise<void> {
  const reconcileMs = deps.reconcileMs ?? 60_000;
  const maxDurationMs = deps.maxDurationMs ?? 10 * 60_000;

  return async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // 同 createSseHandler：过 nginx 系反代（本机 httpserver）需关缓冲，否则帧被攒着不到达
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    let lastWrite = Date.now();
    const send = (chunk: string): void => {
      lastWrite = Date.now();
      res.write(chunk);
    };

    let closed = false;
    let lastCounts: string | null = null;
    const pushCounts = async (): Promise<void> => {
      if (closed) return;
      try {
        const serialized = JSON.stringify(await deps.counts());
        if (serialized === lastCounts) return; // 无变化不推（省流量）
        lastCounts = serialized;
        send(`event: counts\ndata: ${serialized}\n\n`);
      } catch {
        // 计数查询失败跳过本轮，下轮对账自愈（旁路数据不得打断连接）
      }
    };
    await pushCounts();

    const unsubscribe = deps.subscribe((e) => {
      if (closed) return;
      if (e.kind === 'message') send(`event: message\ndata: ${JSON.stringify(e.message)}\n\n`);
      void pushCounts();
    });
    const timer = setInterval(() => void pushCounts(), reconcileMs);

    const deadline = Date.now() + maxDurationMs;
    while (Date.now() < deadline && (deps.shouldContinue?.() ?? true) && !closed) {
      // 空闲心跳：总线静默也要让字节流过代理（read_timeout 防掐线；冒号注释帧客户端忽略）
      if (Date.now() - lastWrite >= KEEPALIVE_MS) send(KEEPALIVE_CHUNK);
      await new Promise((r) => setTimeout(r, 1_000));
    }
    closed = true;
    clearInterval(timer);
    unsubscribe();
    res.end();
  };
}
