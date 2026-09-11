import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, JsonlSink } from '../src/events/bus.js';
import type { AgentEvent } from '../src/types.js';

describe('EventBus', () => {
  it('订阅者按类型收到事件', async () => {
    const bus = new EventBus();
    const received: AgentEvent[] = [];
    bus.on('tool_call', (e) => received.push(e));
    const event: AgentEvent = {
      id: 'e1', ts: Date.now(), taskId: 'T1', employeeId: 'emp-01',
      type: 'tool_call', summary: 'echo',
    };
    await bus.emit(event);
    expect(received).toHaveLength(1);
    expect(received[0].summary).toBe('echo');
  });

  it('JsonlSink 把事件追加写入文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ddw-bus-'));
    try {
      const bus = new EventBus();
      bus.addSink(new JsonlSink(join(dir, 'events.jsonl')));
      const event: AgentEvent = {
        id: 'e2', ts: 123, taskId: 'T1', employeeId: 'emp-01',
        type: 'thinking', summary: '分析任务包',
      };
      await bus.emit(event);
      const raw = await readFile(join(dir, 'events.jsonl'), 'utf8');
      expect(JSON.parse(raw.trim())).toMatchObject({ id: 'e2', type: 'thinking' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('off 注销监听器后不再收到事件（计划执行器逐项核对工具结果的基础，2026-09-05）', async () => {
    const bus = new EventBus();
    const received: AgentEvent[] = [];
    const fn = (e: AgentEvent): void => { received.push(e); };
    bus.on('tool_call', fn);
    await bus.emit({ id: 'e1', ts: 1, taskId: 'T1', employeeId: 'emp', type: 'tool_call', summary: 'a' });
    bus.off('tool_call', fn);
    await bus.emit({ id: 'e2', ts: 2, taskId: 'T1', employeeId: 'emp', type: 'tool_call', summary: 'b' });
    expect(received.map((e) => e.summary)).toEqual(['a']);
  });
});
