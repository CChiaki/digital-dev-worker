import { EventEmitter } from 'node:events';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentEvent } from '../types.js';

export interface EventSink {
  write(event: AgentEvent): Promise<void>;
}

export class JsonlSink {
  constructor(private readonly filePath: string) {}

  async write(event: AgentEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(event) + '\n', 'utf8');
  }
}

export class EventBus {
  private emitter = new EventEmitter();
  private sinks: EventSink[] = [];
  /** 落盘写队列：保证 JSONL 中事件顺序与 emit 调用顺序一致（并发 append 会乱序） */
  private queue: Promise<unknown> = Promise.resolve();

  addSink(sink: EventSink): void {
    this.sinks.push(sink);
  }

  async emit(event: AgentEvent): Promise<void> {
    this.emitter.emit(event.type, event);
    this.emitter.emit('event', event);
    this.queue = this.queue.then(() => Promise.all(this.sinks.map((s) => s.write(event))));
    await this.queue;
  }

  on(type: string, fn: (e: AgentEvent) => void): void {
    this.emitter.on(type, fn);
  }

  /** 注销监听器（计划执行器逐项核对工具结果：项结束即摘除 collector） */
  off(type: string, fn: (e: AgentEvent) => void): void {
    this.emitter.off(type, fn);
  }
}
