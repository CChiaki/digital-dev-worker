import type { AgentEvent } from '@ddw/runtime';
import type { EventFilter, EventStore } from '../types.js';
import type { SqlDriver } from './driver.js';
import { log } from '../../team/logger.js';
import {
  GENESIS_HASH,
  appendHeadSnapshot,
  canonicalContent,
  computeHash,
  loadHeadSnapshots,
  verifyChain,
  verifyHeadSnapshots,
  type HeadSnapshotRecord,
  type IntegrityReport,
} from '../hash-chain.js';

export type { EventFilter } from '../types.js';

/** InnoDB 死锁（并发 append 锁定读 + INSERT 竞争）：mysql2 错误码 ER_LOCK_DEADLOCK */
function isDeadlockError(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === 'ER_LOCK_DEADLOCK' || /deadlock/i.test(err?.message ?? '');
}

interface EventRow {
  id: string;
  ts: number;
  task_id: string;
  employee_id: string;
  type: string;
  summary: string;
  payload: string | null;
  prev_hash: string | null;
  hash: string | null;
  hash_version: number;
  seq: number;
}

/**
 * 事件流 SQL 实现（存储企业化 Task 3）：基于 SqlDriver 方言抽象，sqlite / mysql 共用同一份 DAO——
 * 表 ddw_events（Task 1 建好 schema，构造不建表，ensureSchema 由组装处统一调用），seq 自增保写入序，
 * list 按 (ts, seq) 升序 + 动态 WHERE 过滤（语义与退役的 SqliteEventStore 完全一致）。
 * 审计 hash 链（合规硬要求，零变化）：append 在 driver.tx 内取链尾 hash 计算 prev_hash/hash 落库
 * （mysql 并发下取链尾与插入同事务，链不断）；同 id 重放用 `INSERT ... SELECT ... WHERE NOT EXISTS`
 * 双方言通用判重（affected=0 时 warn 忽略，不用方言 INSERT IGNORE/INSERT OR IGNORE）；
 * verifyIntegrity 全链重算 + 库外快照比对。
 */
export class SqlEventStore implements EventStore {
  private driver: SqlDriver;
  /** 链头快照独立文件（库外存证，如 `<dbPath>.heads.jsonl`）；不传/传 null = 不支持快照（:memory: 语义） */
  private readonly headsPath: string | null;

  constructor(driver: SqlDriver, opts?: { headsPath?: string | null }) {
    this.driver = driver;
    this.headsPath = opts?.headsPath ?? null;
  }

  async append(event: AgentEvent): Promise<void> {
    // 命名互斥锁（mysql GET_LOCK 跨连接/跨实例串行化）：链尾若只靠 FOR UPDATE，InnoDB 下多事务
    // 共享 gap 锁 + INSERT intention 会互相死锁（实测 8 路并发 7 路 ER_LOCK_DEADLOCK）；命名锁
    // 把 append 串行化后才进事务，彻底规避。sqlite 单连接天然串行，直通执行，行为不变。
    // 保留死锁重试兜底（多实例极端竞争下的 ER_LOCK_DEADLOCK，纯库事务体可安全重试，重读链尾不分叉）。
    for (let attempt = 1; ; attempt++) {
      try {
        await this.driver.withNamedLock('ddw_events_append', () => this.appendOnce(event));
        return;
      } catch (e) {
        if (attempt < 5 && isDeadlockError(e)) {
          await new Promise((r) => setTimeout(r, attempt * 20));
          continue;
        }
        throw e;
      }
    }
  }

  private async appendOnce(event: AgentEvent): Promise<void> {
    // 取链尾 + 插入同事务：sqlite 单连接天然原子；mysql 链尾查询经 driver.lockRead 走锁定读
    // （FOR UPDATE）——REPEATABLE READ 普通一致性读不锁行，两并发事务会读到同一 prev_hash 致链分叉
    await this.driver.tx(async () => {
      const tails = await this.driver.all<{ hash: string | null }>(
        this.driver.lockRead('SELECT hash FROM ddw_events ORDER BY seq DESC LIMIT 1'),
      );
      const prevHash = tails[0]?.hash ?? GENESIS_HASH;
      const hash = computeHash(canonicalContent(event, 1), prevHash);
      // INSERT ... SELECT ... WHERE NOT EXISTS：双方言通用判重——同 id 重放 affected=0，不炸进程
      const { affected } = await this.driver.run(
        `INSERT INTO ddw_events (id, ts, task_id, employee_id, type, summary, payload, prev_hash, hash, hash_version)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
         WHERE NOT EXISTS (SELECT 1 FROM ddw_events WHERE id = ?)`,
        [
          event.id, event.ts, event.taskId, event.employeeId, event.type, event.summary,
          event.payload ? this.driver.encodeJson(event.payload) : null,
          prevHash, hash, event.id,
        ],
      );
      if (affected === 0) {
        // 同 id 事件重放（调度器多实例/重启竞态）不炸进程：审计流语义下重复 id 视为已落库
        log.warn('store', `事件重复落库已忽略: ${event.id}`);
      }
    });
  }

  async list(filter?: EventFilter): Promise<AgentEvent[]> {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (filter?.taskId) (conds.push('task_id = ?'), params.push(filter.taskId));
    if (filter?.employeeId) (conds.push('employee_id = ?'), params.push(filter.employeeId));
    if (filter?.type) (conds.push('type = ?'), params.push(filter.type));
    if (filter?.since !== undefined) (conds.push('ts >= ?'), params.push(filter.since));

    const sql = `SELECT seq, id, ts, task_id, employee_id, type, summary, payload, prev_hash, hash
                 FROM ddw_events ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
                 ORDER BY ts ASC, seq ASC`;
    const rows = await this.driver.all<EventRow>(sql, params);
    return rows.map((r) => this.rowToEvent(r));
  }

  /** 审计 hash 链完整性校验：按 seq 全链重算（spec 5.2 篡改可检测）+ 快照比对；canonical 按行版本分流 */
  async verifyIntegrity(): Promise<IntegrityReport> {
    const rows = await this.driver.all<EventRow>(
      'SELECT seq, id, ts, task_id, employee_id, type, summary, payload, prev_hash, hash, hash_version FROM ddw_events ORDER BY seq ASC',
    );
    if (rows.length === 0) return { ok: true, total: 0 };
    const report = verifyChain(
      rows.map((r) => ({
        id: r.id,
        content: canonicalContent(this.rowToEvent(r), r.hash_version ?? 1),
        storedHash: r.hash,
        storedPrev: r.prev_hash,
      })),
    );
    if (!this.headsPath) return report;
    const snaps = await loadHeadSnapshots(this.headsPath);
    if (snaps.length === 0) return report;
    const head = verifyHeadSnapshots(rows.map((r) => ({ id: r.id, storedHash: r.hash })), snaps);
    return { ...report, ok: report.ok && head.ok, headSnapshot: head };
  }

  /** 链头快照归档：把当前末条事件 (id, hash) 追加写入 headsPath 文件 */
  async snapshotHead(): Promise<{ id: string; hash: string }> {
    if (!this.headsPath) throw new Error('未提供快照文件路径（headsPath），不支持链头快照');
    const tails = await this.driver.all<{ id: string; hash: string | null; ts: number }>(
      'SELECT id, hash, ts FROM ddw_events ORDER BY seq DESC LIMIT 1',
    );
    const last = tails[0];
    if (!last?.hash) throw new Error('事件流为空，无链头可快照');
    const rec: HeadSnapshotRecord = { id: last.id, hash: last.hash, ts: last.ts };
    await appendHeadSnapshot(this.headsPath, rec);
    return { id: rec.id, hash: rec.hash };
  }

  private rowToEvent(r: EventRow): AgentEvent {
    return {
      id: r.id,
      ts: r.ts,
      taskId: r.task_id,
      employeeId: r.employee_id,
      type: r.type as AgentEvent['type'],
      summary: r.summary,
      ...(r.payload ? { payload: this.driver.decodeJson<Record<string, unknown>>(r.payload) } : {}),
    };
  }
}
