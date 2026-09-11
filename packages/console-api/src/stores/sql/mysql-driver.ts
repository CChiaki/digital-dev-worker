import { AsyncLocalStorage } from 'node:async_hooks';
import { createPool, type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import type { SqlDriver } from './driver.js';
import { COLUMN_MIGRATIONS, DDL } from './schema.js';

/** 异步上下文绑定的会话：该上下文内所有语句路由到同一连接（命名锁/事务复用，防池连接串话） */
interface MysqlSession {
  conn: PoolConnection;
  /** 该连接上是否已有开启的事务（tx 嵌套判定） */
  txActive: boolean;
}

/**
 * SqlDriver 的 mysql 实现（mysql2/promise 连接池，存储企业化 Task 4）。
 * - 会话路由：AsyncLocalStorage 绑定 { conn }——withNamedLock / tx 的语句（含深层 await）全部落同一
 *   专用连接，绝不让事务体语句落在池里别的连接上；上下文外的语句照常走池。
 * - tx：无上下文时从池取专用连接 BEGIN/COMMIT/ROLLBACK；在 withNamedLock 会话内则复用锁连接开事务
 *   （锁与事务同连接，杜绝「锁占满连接池 → 事务等不到连接」的自饿死）；嵌套 tx 加入外层事务；
 *   异常 rollback 后连接归还池并原样上抛。
 * - withNamedLock：GET_LOCK 服务端级互斥（跨连接/跨实例）。event append 链尾若只靠 FOR UPDATE，
 *   InnoDB 下多事务共享 gap 锁 + INSERT intention 会互相死锁（实测 8 路并发 7 路 ER_LOCK_DEADLOCK），
 *   命名锁把 append 串行化后才进事务，彻底规避；锁与事务同连接，无池饥饿。
 * - lockRead：事务内锁定读包装——REPEATABLE READ 普通一致性读不锁行，并发 append 会读到同一链尾导致
 *   hash 链分叉（T3 评审必做项），链尾查询经此包装追加 FOR UPDATE 作纵深防御。
 * - upsert：ON DUPLICATE KEY UPDATE col = VALUES(col)（兼容 5.7，不用 alias 语法）；resetCols 冲突分支 `col = NULL`。
 * - JSON：encodeJson 双重编码（JSON.stringify(JSON.stringify(v))）——JSON 列存字符串标量防 MySQL
 *   JSON 二进制键排序断审计链（见方法注释）；decodeJson string→parse、非 string 原样（配合 mysql2
 *   对 JSON 列的自动 parse，恰好各解一层）。
 */
export class MysqlDriver implements SqlDriver {
  private pool: Pool;
  private readonly session = new AsyncLocalStorage<MysqlSession>();

  constructor(url: string, opts: { connectionLimit?: number } = {}) {
    // 池韧性参数（2026-09-11 P1 治理批）：此前裸 connectionLimit:10，无建连超时/keepalive/空闲回收——
    // 内网中间设备静默断链后首次查询报错、空闲连接长持不还。补齐 mysql2 池选项：
    // - connectTimeout 10s：建连挂起不再无限等（默认即 10s，显式写出便于运维知悉）
    // - enableKeepAlive + 30s 初始延迟：TCP 保活，防 NAT/防火墙静默掐空闲连接
    // - maxIdle/idleTimeout：空闲连接 60s 归还（mysql2 缺省 maxIdle=connectionLimit 且不回收）
    this.pool = createPool({
      uri: url,
      connectionLimit: opts.connectionLimit ?? 10,
      connectTimeout: 10_000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 30_000,
      maxIdle: opts.connectionLimit ?? 10,
      idleTimeout: 60_000,
      namedPlaceholders: false,
      waitForConnections: true,
    });
  }

  async ensureSchema(): Promise<void> {
    for (const stmt of DDL.mysql) await this.exec(stmt);
    // 存量库补列（2026-09-11 P1 治理批）：information_schema 探测幂等 ALTER（库内 DDL 自带元数据锁）
    for (const m of COLUMN_MIGRATIONS) {
      const rows = await this.all<RowDataPacket>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [m.table, m.column],
      );
      if (rows.length > 0) continue;
      await this.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.mysql}`);
      if (m.backfill) await this.exec(m.backfill);
    }
  }

  /** 当前语句执行目标：会话上下文内用绑定连接，上下文外从池取（用后即还） */
  private async conn(): Promise<PoolConnection> {
    return this.session.getStore()?.conn ?? (await this.pool.getConnection());
  }

  /** conn() 取的是池连接且不在会话上下文内时需归还；会话绑定连接由 withNamedLock/tx 统一释放 */
  private releaseIfPool(conn: PoolConnection): void {
    if (this.session.getStore()?.conn !== conn) conn.release();
  }

  async exec(sql: string, params?: unknown[]): Promise<void> {
    const conn = await this.conn();
    try {
      await conn.query(sql, params ?? []);
    } finally {
      this.releaseIfPool(conn);
    }
  }

  async run(sql: string, params?: unknown[]): Promise<{ affected: number }> {
    const conn = await this.conn();
    try {
      const [result] = await conn.query<ResultSetHeader>(sql, params ?? []);
      return { affected: result.affectedRows ?? 0 };
    } finally {
      this.releaseIfPool(conn);
    }
  }

  async all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    const conn = await this.conn();
    try {
      const [rows] = await conn.query<RowDataPacket[]>(sql, params ?? []);
      return rows as unknown as T[];
    } finally {
      this.releaseIfPool(conn);
    }
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const s = this.session.getStore();
    if (s?.txActive) return fn(); // 嵌套 tx：加入外层事务（无需 savepoint）
    // 命名锁会话内复用锁连接开事务；否则从池取专用连接
    const owned = !s;
    const conn = s ? s.conn : await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      if (owned) {
        const r = await this.session.run({ conn, txActive: true }, fn);
        await conn.commit();
        return r;
      }
      s!.txActive = true;
      try {
        const r = await fn();
        await conn.commit();
        return r;
      } finally {
        s!.txActive = false;
      }
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        // rollback 失败不掩盖业务异常：连接释放后由池自愈
      }
      throw e;
    } finally {
      if (owned) conn.release();
    }
  }

  /** 命名互斥锁：GET_LOCK 等待至多 10s（1=拿到，0=超时，NULL=出错）；fn 全程与锁同一连接 */
  async withNamedLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      const [rows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS got', [name]);
      const got = (rows[0] as { got?: number | null } | undefined)?.got;
      if (got !== 1) throw new Error(`获取命名互斥锁失败（超时或出错）: ${name}`);
      try {
        return await this.session.run({ conn, txActive: false }, fn);
      } finally {
        try {
          await conn.query('SELECT RELEASE_LOCK(?)', [name]);
        } catch {
          // 释放失败不掩盖业务异常；连接归还池后随会话断开自动释放
        }
      }
    } finally {
      conn.release();
    }
  }

  /** 事务内锁定读：mysql 追加 FOR UPDATE（防止并发 append 读到同一链尾致链分叉，纵深防御） */
  lockRead(sql: string): string {
    return `${sql} FOR UPDATE`;
  }

  /** mysql 方言 upsert：ON DUPLICATE KEY UPDATE col = VALUES(col)（兼容 5.7 不用 alias 语法）；
   *  resetCols 冲突分支直写 col = NULL（重提交清残留的覆盖语义，见 driver.ts 接口注释） */
  upsertSql(table: string, pkCol: string, cols: string[], resetCols?: string[]): string {
    const all = [pkCol, ...cols];
    const updates = [
      ...cols.map((c) => `${c} = VALUES(${c})`),
      ...(resetCols ?? []).map((c) => `${c} = NULL`),
    ].join(', ');
    return `INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${updates}`;
  }

  /**
   * 双重编码（T8 评审必修）：MySQL JSON 列以二进制格式存储，会把对象键按（长度、字节序）排序——
   * 插入序丢失。事件 payload 若直存对象，verifyIntegrity 重算 canonical hash（JSON.stringify 键序
   * 敏感）时键序与 append 时不同，hash 必失配断链（审计合规硬要求）。改为对已 stringify 的字符串
   * 再 encode 一层：JSON 列存的是字符串标量，MySQL 对字符串标量不做键重排，插入键序原样保住；
   * 读回时 mysql2 对 JSON 列自动 parse 得到内层 JSON 文本字符串，decodeJson（string→parse）再解
   * 一层还原原序对象。对其余 6 个 store 的 encodeJson/decodeJson 调用完全透明（往返各多一层、
   * 层数恰好抵消），sqlite 驱动不受影响。
   */
  encodeJson(v: unknown): unknown {
    return JSON.stringify(JSON.stringify(v));
  }

  decodeJson<T>(v: unknown): T {
    // 非 string 原样返回：不依赖 mysql2 对 JSON 列的解析行为
    return (typeof v === 'string' ? JSON.parse(v) : v) as T;
  }

  async close(): Promise<void> {
    if (!this.pool) return; // 幂等：重复 close 无害
    await this.pool.end();
    this.pool = undefined as unknown as Pool;
  }
}

/** 创建 mysql 驱动（url 形如 mysql://user:pass@host:port/db?charset=utf8mb4；
 *  connectionLimit 可选，yaml storage.mysql.connectionLimit 透传，缺省 10） */
export async function createMysqlDriver(url: string, opts: { connectionLimit?: number } = {}): Promise<SqlDriver> {
  return new MysqlDriver(url, opts);
}
