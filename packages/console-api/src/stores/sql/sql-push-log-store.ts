import type { PushLogListOpts, PushLogRecord, PushLogStore } from '../../team/push-log.js';
import type { SqlDriver } from './driver.js';
import { sortableId } from './sortable-id.js';

export type { PushLogRecord } from '../../team/push-log.js';

/** 只保留最近 2000 条（消息 × 渠道量级 = 消息中心 1000 × 启用渠道数，留痕两倍余量），超限丢最旧 */
const MAX_PUSH_LOGS = 2000;

/**
 * 滚动删除（同表子查询 DELETE 两方言通用，与 SqlMessageStore 同款）：
 * mysql 不支持 IN 子查询内直接 LIMIT，包一层派生表绕开；sqlite 同语法兼容。
 */
const ROLLING_DELETE =
  `DELETE FROM ddw_push_logs WHERE id NOT IN ` +
  `(SELECT id FROM (SELECT id FROM ddw_push_logs ORDER BY created_at DESC, id DESC LIMIT ${MAX_PUSH_LOGS}) t)`;

/**
 * 推送留痕 SQL 实现（2026-09-10 用户需求）：表 ddw_push_logs（id PK + created_at 窄列 + doc JSON）。
 * 每条消息 × 每个渠道推送一条（sent/failed + 燕讯 seqNo）——推送留痕是旁路观测数据，
 * server 侧 add 失败只记日志不阻断消息流。
 */
export class SqlPushLogStore implements PushLogStore {
  constructor(private readonly driver: SqlDriver) {}

  async list(opts?: PushLogListOpts): Promise<PushLogRecord[]> {
    // taskId/messageId/limit 在 JS 侧过滤（doc JSON 列 LIKE 匹配在 OceanBase 有空格兼容问题，
    // 量级 ≤2000 内存过滤无压力——与 SqlMessageStore.list 同决策）
    const rows = await this.driver.all<{ doc: unknown }>(
      'SELECT doc FROM ddw_push_logs ORDER BY created_at DESC, id DESC',
    );
    return rows
      .map((r) => this.driver.decodeJson<PushLogRecord>(r.doc))
      .filter((r) =>
        (!opts?.taskId || r.taskId === opts.taskId)
        && (!opts?.messageId || r.messageId === opts.messageId))
      .slice(0, opts?.limit ?? 200)
      .map((r) => structuredClone(r));
  }

  async add(rec: Omit<PushLogRecord, 'id' | 'createdAt'> & { id?: string }): Promise<PushLogRecord> {
    return this.driver.tx(async () => {
      const full: PushLogRecord = {
        ...rec,
        id: rec.id ?? sortableId('push'),
        createdAt: Date.now(),
      };
      await this.driver.run(
        'INSERT INTO ddw_push_logs (id, created_at, doc) VALUES (?, ?, ?)',
        [full.id, full.createdAt, this.driver.encodeJson(full)],
      );
      await this.driver.exec(ROLLING_DELETE);
      return structuredClone(full);
    });
  }
}
