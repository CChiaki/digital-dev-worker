import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonlSink } from '@ddw/runtime';
import type { AgentEvent } from '@ddw/runtime';
import type { EventFilter, EventStore } from './types.js';
import { GENESIS_HASH, canonicalContent, computeHash, verifyChain, type IntegrityReport } from './hash-chain.js';

import { appendHeadSnapshot, loadHeadSnapshots, verifyHeadSnapshots, type HeadSnapshotRecord } from './hash-chain.js';

export type { EventFilter } from './types.js';

/** 链头快照独立文件（库外存证）；readAll 须排除，否则会被当事件读入 */
const HEADS_FILE = 'audit-heads.jsonl';

/** 落盘事件 = AgentEvent + 链元数据（list 时多余字段无害，canonical 只取审计字段） */
interface ChainedEvent extends AgentEvent {
  prevHash?: string;
  hash?: string;
  /** canonical 版本（P9-B 版本化；旧行缺省按 1 重算） */
  hashVersion?: number;
}

/**
 * 事件流文件实现（测试 Fake / 极简部署）：append 复用 runtime 的 JsonlSink（`<dir>/events.jsonl`），
 * list 递归读目录下所有 *.jsonl（半行/写入中跳过），按 ts 升序返回。
 * 审计 hash 链：append 前取流内最后一行 hash 计算 prev_hash/hash 一并落盘，verifyIntegrity 全链重算。
 */
export class FileEventStore implements EventStore {
  private lastHash: string | null = null; // 会话内缓存；null 时从盘上末行懒加载
  private queue: Promise<void> = Promise.resolve(); // append 串行化：保 JSONL 行序 = 调用序，链不断

  constructor(private readonly dir: string) {}

  async append(event: AgentEvent): Promise<void> {
    const run = this.queue.then(async () => {
      const prevHash = this.lastHash ?? (await this.readLastHash()) ?? GENESIS_HASH;
      const hash = computeHash(canonicalContent(event, 1), prevHash);
      await new JsonlSink(join(this.dir, 'events.jsonl')).write({ ...event, prevHash, hash, hashVersion: 1 } as ChainedEvent);
      this.lastHash = hash;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async list(filter?: EventFilter): Promise<AgentEvent[]> {
    const events = await this.readAll();
    if (!filter) return events;
    return events.filter(
      (e) =>
        (!filter.taskId || e.taskId === filter.taskId) &&
        (!filter.employeeId || e.employeeId === filter.employeeId) &&
        (!filter.type || e.type === filter.type) &&
        (filter.since === undefined || e.ts >= filter.since),
    );
  }

  /** 审计 hash 链完整性校验（spec 5.2 篡改可检测）：按落盘行序（= append 序）重算 + 快照比对 */
  async verifyIntegrity(): Promise<IntegrityReport> {
    const all = (await this.readAll(false)) as ChainedEvent[];
    if (all.length === 0) return { ok: true, total: 0 };
    const report = verifyChain(
      all.map((e) => ({
        id: e.id,
        content: canonicalContent(e, e.hashVersion ?? 1),
        storedHash: e.hash ?? null,
        storedPrev: e.prevHash ?? null,
      })),
    );
    return this.withSnapshotCheck(report, all);
  }

  /** 链头快照归档：把当前末条事件 (id, hash) 追加写入 `<dir>/audit-heads.jsonl` */
  async snapshotHead(): Promise<{ id: string; hash: string }> {
    const last = (await this.readAll(false)).at(-1) as ChainedEvent | undefined;
    if (!last?.hash) throw new Error('事件流为空，无链头可快照');
    const rec: HeadSnapshotRecord = { id: last.id, hash: last.hash, ts: last.ts };
    await appendHeadSnapshot(join(this.dir, HEADS_FILE), rec);
    return { id: rec.id, hash: rec.hash };
  }

  /** 在链校验报告上叠加快照比对结果（库外存证防"重算整条链"） */
  private async withSnapshotCheck(report: IntegrityReport, all: ChainedEvent[]): Promise<IntegrityReport> {
    const snaps = await loadHeadSnapshots(join(this.dir, HEADS_FILE));
    if (snaps.length === 0) return report;
    const head = verifyHeadSnapshots(all.map((e) => ({ id: e.id, storedHash: e.hash ?? null })), snaps);
    return { ...report, ok: report.ok && head.ok, headSnapshot: head };
  }

  private async readLastHash(): Promise<string | null> {
    const all = await this.readAll(false);
    const last = all.at(-1) as ChainedEvent | undefined;
    return last?.hash ?? null;
  }

  private async readAll(sorted = true): Promise<AgentEvent[]> {
    const files = await this.jsonlFiles(this.dir);
    const events: AgentEvent[] = [];
    for (const file of files) {
      let text = '';
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as AgentEvent);
        } catch {
          // 半行（写入中）或损坏行：跳过
        }
      }
    }
    if (sorted) events.sort((a, b) => a.ts - b.ts);
    return events;
  }

  private async jsonlFiles(dir: string): Promise<string[]> {
    let entries: string[] = [];
    try {
      entries = await readdir(dir, { recursive: true });
    } catch {
      return [];
    }
    return entries.filter((f) => f.endsWith('.jsonl') && !f.endsWith(HEADS_FILE)).map((f) => join(dir, f));
  }
}
