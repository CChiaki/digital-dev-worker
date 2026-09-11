import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqlDriver } from './driver.js';
import { COLUMN_MIGRATIONS, DDL } from './schema.js';

/** node:sqlite 绑定参数类型收窄（SQLInputValue）——上层统一传 unknown */
function toBindParams(params?: unknown[]): SQLInputValue[] {
  return (params ?? []) as SQLInputValue[];
}

/**
 * SqlDriver 的 sqlite 实现（node:sqlite DatabaseSync，零依赖零编译）。
 * node:sqlite 为同步 API，统一包成 async 收敛接口；单连接单进程（Console API 现状语义）。
 */
export class SqliteDriver implements SqlDriver {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
  }

  async ensureSchema(): Promise<void> {
    for (const stmt of DDL.sqlite) await this.exec(stmt);
    // 存量库补列（2026-09-11 P1 治理批）：CREATE IF NOT EXISTS 对已建表不生效，PRAGMA 探测幂等 ALTER
    for (const m of COLUMN_MIGRATIONS) {
      const cols = await this.all<{ name: string }>(`PRAGMA table_info(${m.table})`);
      if (cols.some((c) => c.name === m.column)) continue;
      await this.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.sqlite}`);
      if (m.backfill) await this.exec(m.backfill);
    }
  }

  async exec(sql: string, params?: unknown[]): Promise<void> {
    // node:sqlite 的 exec 不收参数；带参语句走 prepare().run()
    if (params && params.length > 0) this.db.prepare(sql).run(...toBindParams(params));
    else this.db.exec(sql);
  }

  async run(sql: string, params?: unknown[]): Promise<{ affected: number }> {
    const info = this.db.prepare(sql).run(...toBindParams(params));
    return { affected: Number(info.changes) };
  }

  async all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...toBindParams(params)) as unknown as T[];
  }

  /** sqlite 无 FOR UPDATE（也不需要）：单连接天然串行，锁定读包装原样返回 */
  lockRead(sql: string): string {
    return sql;
  }

  /** sqlite 单连接天然串行：命名互斥锁无意义，直接执行 fn（行为不变） */
  async withNamedLock<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  /** node:sqlite 无显式事务 API：BEGIN/COMMIT/ROLLBACK exec 等价实现（spec §4 决策）。
   *  串行队列（T7 评审 P1）：node:sqlite 单连接上并发两个 BEGIN 即炸「cannot start a transaction
   *  within a transaction」（T7 种子期实际踩炸），tx 经 txChain 排队——任一时刻至多一个事务活跃，
   *  顺序调用零行为变化；失败也归一推进队列，防断链卡死后续事务。 */
  private txChain: Promise<unknown> = Promise.resolve();

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.txChain.then(async () => {
      // BEGIN 失败直接上抛（无事务可回滚，不做 ROLLBACK 以免二次报错掩埋原始错误）
      await this.exec('BEGIN');
      try {
        const r = await fn();
        await this.exec('COMMIT');
        return r;
      } catch (e) {
        // ROLLBACK 可能自身失败（无活动事务/连接态异常）：吞掉其错误，原始错误原样上抛
        try {
          await this.exec('ROLLBACK');
        } catch {
          // 回滚失败不掩盖业务异常
        }
        throw e;
      }
    });
    // 队列归还：无论本事务成败都把链推进到已 settle 的 Promise，失败不入链防后续事务被跳过
    this.txChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run as Promise<T>;
  }

  /** sqlite 方言 upsert：INSERT ... ON CONFLICT(pk) DO UPDATE SET col = excluded.col；
   *  resetCols 冲突分支直写 col = NULL（重提交清残留的覆盖语义，见 driver.ts 接口注释） */
  upsertSql(table: string, pkCol: string, cols: string[], resetCols?: string[]): string {
    const all = [pkCol, ...cols];
    const updates = [
      ...cols.map((c) => `${c} = excluded.${c}`),
      ...(resetCols ?? []).map((c) => `${c} = NULL`),
    ].join(', ');
    return `INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')}) ON CONFLICT(${pkCol}) DO UPDATE SET ${updates}`;
  }

  encodeJson(v: unknown): unknown {
    return JSON.stringify(v);
  }

  decodeJson<T>(v: unknown): T {
    // 非 string 原样返回：防御 mysql2 对 JSON 列自动 parse 的行为差异
    return (typeof v === 'string' ? JSON.parse(v) : v) as T;
  }

  async close(): Promise<void> {
    if (!this.db) return; // 幂等：重复 close 无害
    this.db.close();
    this.db = undefined as unknown as DatabaseSync;
  }
}
