import type { MessageListOpts, MessageRecord, MessageStore, NewMessage } from '../../team/messages.js';
import type { SqlDriver } from './driver.js';
import { sortableId } from './sortable-id.js';

export type { MessageRecord, NewMessage } from '../../team/messages.js';

/** 只保留最近 1000 条，超限丢最旧（与 FileMessageStore 同上限） */
const MAX_MESSAGES = 1000;

/**
 * 滚动删除（同表子查询 DELETE 两方言通用）：mysql 不支持 IN 子查询内直接 LIMIT，
 * 包一层派生表绕开；sqlite 同语法兼容。排序 created_at DESC, id DESC 与 list 同序——
 * 保留的恰是 list 可见的最新 1000 条。
 */
const ROLLING_DELETE =
  `DELETE FROM ddw_messages WHERE id NOT IN ` +
  `(SELECT id FROM (SELECT id FROM ddw_messages ORDER BY created_at DESC, id DESC LIMIT ${MAX_MESSAGES}) t)`;

/**
 * 消息中心 SQL 实现（存储企业化 spec §4/§5，T6）：表 ddw_messages（id PK + read/created_at 窄列 + doc JSON）。
 * 语义对齐 FileMessageStore（implements MessageStore，防两实现漂移）：
 * - add 补齐 id/createdAt；insert 与 1000 条滚动删除包同一事务（File unshift+slice 的表化对应）；
 * - readAt 存 doc JSON 内，read 窄列为冗余索引列：markRead/markAllRead 读改写 doc 时同步置 1；
 * - markRead 幂等（已读返回 true 不重写），markAllRead 只补未读并返回本次标记条数；
 * - list 最新在前（created_at DESC, id DESC；同毫秒由 id 决序——File 为严格插入序，业务只要求最新在前）。
 */
export class SqlMessageStore implements MessageStore {
  constructor(private readonly driver: SqlDriver) {}

  async list(opts?: MessageListOpts): Promise<MessageRecord[]> {
    // unreadOnly 走 read 窄列（索引列）；type/q 在 JS 过滤——MySQL JSON 列转字符串会插空格，
    // doc LIKE '%"type":"x"%' 在 OceanBase 匹配不上（2026-09-10 实测）；上限 1000 条内存过滤无压力
    const rows = await this.driver.all<{ doc: unknown }>(
      'SELECT doc FROM ddw_messages' +
      (opts?.unreadOnly ? ' WHERE `read` = 0' : '') +
      ' ORDER BY created_at DESC, id DESC',
    );
    const q = opts?.q?.toLowerCase();
    return rows
      .map((r) => this.driver.decodeJson<MessageRecord>(r.doc))
      .filter((m) =>
        (!opts?.type || m.type === opts.type)
        && (!q
          || m.title.toLowerCase().includes(q)
          || m.summary.toLowerCase().includes(q)
          || m.taskId.toLowerCase().includes(q)))
      .map((m) => structuredClone(m));
  }

  async unreadCount(): Promise<number> {
    const rows = await this.driver.all<{ n: unknown }>('SELECT COUNT(*) AS n FROM ddw_messages WHERE `read` = 0');
    return Number(rows[0]?.n ?? 0);
  }

  async add(m: NewMessage): Promise<MessageRecord> {
    return this.driver.tx(async () => {
      const rec: MessageRecord = {
        ...m,
        id: m.id ?? sortableId('msg'),
        createdAt: Date.now(),
      };
      await this.driver.run(
        'INSERT INTO ddw_messages (id, `read`, created_at, doc) VALUES (?, 0, ?, ?)',
        [rec.id, rec.createdAt, this.driver.encodeJson(rec)],
      );
      await this.driver.exec(ROLLING_DELETE);
      return structuredClone(rec);
    });
  }

  /** 标记已读；消息不存在返回 false；已读幂等返回 true 且 readAt 不被覆盖 */
  async markRead(id: string): Promise<boolean> {
    return this.driver.tx(async () => {
      const rows = await this.driver.all<{ doc: unknown }>('SELECT doc FROM ddw_messages WHERE id = ?', [id]);
      const row = rows[0];
      if (!row) return false;
      const rec = this.driver.decodeJson<MessageRecord>(row.doc);
      if (rec.readAt !== undefined) return true; // 已读幂等：不重写 readAt
      rec.readAt = Date.now();
      await this.driver.run('UPDATE ddw_messages SET `read` = 1, doc = ? WHERE id = ?', [
        this.driver.encodeJson(rec), id,
      ]);
      return true;
    });
  }

  /** 全部标记已读（已读的不动），返回本次标记条数 */
  async markAllRead(): Promise<number> {
    return this.driver.tx(async () => {
      const rows = await this.driver.all<{ id: string; doc: unknown }>(
        'SELECT id, doc FROM ddw_messages WHERE `read` = 0',
      );
      const now = Date.now();
      for (const row of rows) {
        const rec = this.driver.decodeJson<MessageRecord>(row.doc);
        rec.readAt = now; // 同一批统一 readAt（与 File 同语义）
        await this.driver.run('UPDATE ddw_messages SET `read` = 1, doc = ? WHERE id = ?', [
          this.driver.encodeJson(rec), row.id,
        ]);
      }
      return rows.length;
    });
  }
}
