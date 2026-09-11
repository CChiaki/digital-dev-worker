import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '@ddw/runtime';

/**
 * agent 事件直播订阅单测（2026-09-11 P2 产品批）：
 * Fake EventSource 注入全局——验证单例连接（多订阅者共享）、事件分发、
 * 以及重连回放（URL 静态 since → 服务端重推订阅时刻后全部事件）的 ts 水位幂等去重。
 * live.ts 是模块级单例，每用例 vi.resetModules + 动态 import 取全新连接状态。
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: (e: { data: string }) => void): void {
    const arr = this.listeners.get(name) ?? [];
    arr.push(fn);
    this.listeners.set(name, arr);
  }

  /** 服务端推一帧 agent-event */
  emit(e: AgentEvent): void {
    for (const fn of this.listeners.get('agent-event') ?? []) fn({ data: JSON.stringify(e) });
  }
}

const ev = (id: string, ts: number): AgentEvent => ({
  id, ts, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: 'echo', payload: {},
});

/** 每用例全新 live 模块（连接单例与 ts 水位归零） */
async function freshLive(): Promise<typeof import('../src/live.js')> {
  vi.resetModules();
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
  return import('../src/live.js');
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
});

describe('onAgentEvent（agent 事件直播订阅，2026-09-11 P2 产品批）', () => {
  it('首个订阅者建立连接：URL 带 since；事件分发到全部订阅者', async () => {
    const { onAgentEvent } = await freshLive();
    const got1: AgentEvent[] = [];
    const got2: AgentEvent[] = [];
    onAgentEvent((e) => got1.push(e));
    expect(FakeEventSource.instances).toHaveLength(1);
    // 只订增量：历史由页面 API 拉取，重连不回放全量
    const src = FakeEventSource.instances[0]!;
    expect(src.url).toMatch(/^\/api\/events\/stream\?since=\d+/);

    onAgentEvent((e) => got2.push(e));
    expect(FakeEventSource.instances).toHaveLength(1); // 单例：第二个订阅者复用连接

    src.emit(ev('e1', Date.now() + 1));
    expect(got1.map((e) => e.id)).toEqual(['e1']);
    expect(got2.map((e) => e.id)).toEqual(['e1']);
  });

  it('重连回放幂等去重：ts 水位之前的事件（服务端静态 since 重推）不重复分发', async () => {
    const base = Date.now(); // 订阅时刻在 freshLive 之后——水位即构造时刻
    const { onAgentEvent } = await freshLive();
    const got: AgentEvent[] = [];
    onAgentEvent((e) => got.push(e));
    const src = FakeEventSource.instances[0]!;

    src.emit(ev('e1', base + 1000));
    src.emit(ev('e2', base + 1500));
    expect(got.map((e) => e.id)).toEqual(['e1', 'e2']);

    // 模拟断线重连：服务端从 URL 上的 since（订阅时刻）重推全部事件
    src.emit(ev('e1', base + 1000));
    src.emit(ev('e2', base + 1500));
    src.emit(ev('e3', base + 2000)); // 断线窗口内产生的新事件：正常补投
    expect(got.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('退订后不再分发；onerror 不中断连接对象（EventSource 自愈重连由浏览器负责）', async () => {
    const { onAgentEvent } = await freshLive();
    const base = Date.now(); // 订阅已建立（since 已定格），此后的事件都在增量窗口内
    const got: AgentEvent[] = [];
    const sub = onAgentEvent((e) => got.push(e));
    const src = FakeEventSource.instances[0]!;

    src.onerror?.();
    src.emit(ev('e1', base + 1));
    expect(got).toHaveLength(1);

    sub.off();
    src.emit(ev('e2', base + 2));
    expect(got).toHaveLength(1); // 退订后静默
  });
});
