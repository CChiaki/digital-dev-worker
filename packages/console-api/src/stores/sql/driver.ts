/**
 * 存储驱动抽象层（存储企业化 spec §4）：上层 DAO 只见 async 接口，
 * sqlite / mysql 方言差异（upsert、JSON 编解码、affected 行数）收在各自驱动实现内。
 */
export interface SqlDriver {
  /** 幂等建 8 表 + 索引（启动时执行） */
  ensureSchema(): Promise<void>;
  /** DDL / 无返回语句 */
  exec(sql: string, params?: unknown[]): Promise<void>;
  /** DML，affected = changes / affectedRows */
  run(sql: string, params?: unknown[]): Promise<{ affected: number }>;
  all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  /** BEGIN/COMMIT/ROLLBACK：fn 抛错回滚后原样上抛 */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  /** 事务内锁定读（方言包装）：需要串行化语义的 SELECT（如 event 链尾查询）必须经此——
   *  sqlite 原样返回（单连接天然串行）；mysql 追加 FOR UPDATE（REPEATABLE READ 普通一致性读不锁，
   *  并发 append 会读到同一链尾导致 hash 链分叉，T3 评审必做项；锁粒度小于 SERIALIZABLE） */
  lockRead(sql: string): string;
  /** 命名互斥锁（串行化临界区）：mysql 用 GET_LOCK（服务端级跨连接/跨实例互斥，且锁在真实锁对象上
   *  ——链尾 FOR UPDATE 在 InnoDB 下多事务共享 gap 锁 + INSERT intention 会互相死锁，命名锁彻底规避）；
   *  sqlite 单连接天然串行，直接执行 fn。fn 抛错必须先释放锁再原样上抛。 */
  withNamedLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** 方言 upsert SQL（sqlite ON CONFLICT DO UPDATE / mysql ON DUPLICATE KEY UPDATE）。
   *  resetCols（可选）：冲突时置 NULL 的列——「重提交同 pk 清残留」的覆盖语义用
   *  （sqlite `col = NULL` 与 mysql `ON DUPLICATE KEY UPDATE col = NULL` 均支持直写 NULL） */
  upsertSql(table: string, pkCol: string, cols: string[], resetCols?: string[]): string;
  /** 统一 JSON.stringify 字符串入库 */
  encodeJson(v: unknown): unknown;
  /** string→parse，非 string 原样（防御 mysql2 行为差异） */
  decodeJson<T>(v: unknown): T;
  close(): Promise<void>;
}

export const TABLES = [
  'ddw_tasks',
  'ddw_events',
  'ddw_employees',
  'ddw_skill_categories',
  'ddw_skills',
  'ddw_capabilities',
  'ddw_messages',
  'ddw_channels',
  'ddw_generations',
  'ddw_push_logs',
] as const;
