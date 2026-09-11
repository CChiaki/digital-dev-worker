import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSseHandler } from '../src/http/sse.js';
import { FileEventStore } from '../src/stores/index.js';
import type { AgentEvent } from '@ddw/runtime';

let root: string;
let events: FileEventStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-sse-'));
  events = new FileEventStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ev = (id: string, ts: number): AgentEvent => ({
  id, ts, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: id,
});

/** 收集 SSE 输出的 mock res（不监听端口） */
class MockRes {
  chunks: string[] = [];
  ended = false;
  aborted = false;
  writeHead(status: number, headers: Record<string, string>) {
    this.chunks.push(`__HEAD__${status}:${JSON.stringify(headers)}`);
  }
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.ended = true;
  }
}

describe('SSE 直播流', () => {
  it('首帧头 + retry + 增量事件帧，格式正确', async () => {
    await events.append(ev('e1', 1000));
    const handler = createSseHandler(events, { intervalMs: 5, maxDurationMs: 40 });
    const res = new MockRes();
    await handler({ path: '/api/events/stream', query: { taskId: 'T1' } }, res);

    const head = res.chunks.find((c) => c.startsWith('__HEAD__'));
    expect(head).toContain('200');
    expect(head).toContain('text/event-stream');

    const text = res.chunks.filter((c) => !c.startsWith('__HEAD__')).join('');
    expect(text).toContain('retry:');
    // e1 出现在 data 帧（JSON 单行）
    expect(text).toContain(`data: {"id":"e1"`);
    expect(text).toContain('\n\n'); // 帧以空行结束
    expect(res.ended).toBe(true);
  }, 10_000);

  it('since 语义 = at-least-once：重连重推幂等帧；期间新事件推到且不无限重推', async () => {
    await events.append(ev('e1', 1000));
    const handler = createSseHandler(events, { intervalMs: 5, maxDurationMs: 60 });
    const res = new MockRes();

    // 模拟客户端带着上次的 since 重连后，直播期间新事件落盘
    setTimeout(() => void events.append(ev('e2', 2000)), 10);
    await handler({ path: '/api/events/stream', query: { taskId: 'T1', since: '1000' } }, res);

    const text = res.chunks.join('');
    expect(text).toContain('"e1"'); // 重推一条（客户端按 id 幂等去重）
    expect(text).toContain('"e2"'); // 新事件推到
    // 用 data 帧头精确计数（事件 JSON 的 summary 也含 id，不能直接数 '"e1"'）
    const frames = (id: string) => text.split(`data: {"id":"${id}"`).length - 1;
    expect(frames('e1')).toBe(1); // 关键：不无限重推
    expect(frames('e2')).toBe(1);
  }, 10_000);
});
