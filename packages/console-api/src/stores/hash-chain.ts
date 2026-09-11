import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import type { AgentEvent } from '@ddw/runtime';

/** 链头（创世）prev_hash：64 个 '0'，spec 5.2 审计 hash 链定稿 */
export const GENESIS_HASH = '0'.repeat(64);

export interface IntegrityReport {
  ok: boolean;
  total: number;
  /** 首个被篡改/断链的事件 id */
  brokenAt?: string;
  /** 链头快照比对结果（无快照文件时缺省） */
  headSnapshot?: { ok: boolean; checked: number; brokenAt?: string };
}

/**
 * 事件 canonical 内容：只取审计字段、固定键序，保证 append 时与验证时逐字节一致。
 * （list 返回对象上可能附带的 prevHash/hash 等链元数据不参与 hash。）
 *
 * canonical 版本化（P9-B）：未来给 AgentEvent 加审计字段时升 version 并新增 v2 键集，
 * 历史行仍按各自落库版本重算——改动 canonical 不再导致全链断链。
 */
export function canonicalContent(e: AgentEvent, version: number = 1): string {
  if (version !== 1) throw new Error(`未知的 canonical 版本: ${version}`);
  return JSON.stringify({
    id: e.id,
    ts: e.ts,
    taskId: e.taskId,
    employeeId: e.employeeId,
    type: e.type,
    summary: e.summary,
    payload: e.payload ?? null,
  });
}

/** hash = SHA-256(canonical + prevHash)，逐条成链：改任何一条，其后全部断链 */
export function computeHash(content: string, prevHash: string): string {
  return createHash('sha256').update(content + prevHash).digest('hex');
}

interface ChainRow {
  id: string;
  content: string;
  storedHash: string | null;
  storedPrev: string | null;
}

/**
 * 全链校验：重算每条 hash 与存储值比对（prev_hash 也须衔接）。
 * 返回首个断点（篡改位置），全绿则 ok: true。
 */
export function verifyChain(rows: ChainRow[]): IntegrityReport {
  let prev = GENESIS_HASH;
  for (const row of rows) {
    if (row.storedPrev !== prev || row.storedHash !== computeHash(row.content, prev)) {
      return { ok: false, total: rows.length, brokenAt: row.id };
    }
    prev = row.storedHash!;
  }
  return { ok: true, total: rows.length };
}

// ── 链头快照归档（P9-A）─────────────────────────────────────────────
// 快照 = 当时链头 (id, hash) 追加写入独立文件。全链重算防不住"改库者重算整条链"，
// 快照在库外：篡改点 ≤ 快照链头时，重算后链头的存储 hash 必变，与快照失配即暴露。

/** 快照记录：一行一条 JSON，追加写（永不覆盖，保留历史锚点） */
export interface HeadSnapshotRecord {
  id: string;
  hash: string;
  ts: number;
}

export async function appendHeadSnapshot(path: string, rec: HeadSnapshotRecord): Promise<void> {
  await appendFile(path, JSON.stringify(rec) + '\n', 'utf8');
}

/** 读快照文件；不存在返回 [] */
export async function loadHeadSnapshots(path: string): Promise<HeadSnapshotRecord[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const recs: HeadSnapshotRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      recs.push(JSON.parse(line) as HeadSnapshotRecord);
    } catch {
      // 损坏行：跳过
    }
  }
  return recs;
}

/**
 * 快照比对：每条快照记录的 hash 必须与当前链中同一 id 事件的存储 hash 一致
 * （比对存储值而非重算值——重算用的就是被改过的数据，自洽不代表没被改）。
 * 快照指向的事件在当前链中不存在也视为失配。
 */
export function verifyHeadSnapshots(
  rows: { id: string; storedHash: string | null }[],
  snaps: HeadSnapshotRecord[],
): { ok: boolean; checked: number; brokenAt?: string } {
  const byId = new Map(rows.map((r) => [r.id, r.storedHash]));
  for (const s of snaps) {
    if (!byId.has(s.id) || byId.get(s.id) !== s.hash) {
      return { ok: false, checked: snaps.length, brokenAt: s.id };
    }
  }
  return { ok: true, checked: snaps.length };
}
