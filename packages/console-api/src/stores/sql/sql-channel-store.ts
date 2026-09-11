import { validateChannelDef, type ChannelStore, type NotificationChannelDef } from '../../team/notifier.js';
import type { SqlDriver } from './driver.js';

export type { NotificationChannelDef } from '../../team/notifier.js';

/**
 * 通知渠道注册表 SQL 实现（存储企业化 spec §4/§5，T5）：表 ddw_channels（id PK + doc JSON）。
 * 业务规则（validateChannelDef 校验）复用 team/notifier.ts 导出纯函数，防两实现漂移；
 * secret 随 doc JSON 原样存取（脱敏由 HTTP 层 redactChannel 负责，与 File 实现一致）。
 * upsert 校验在 store 内做（与 FileChannelStore.upsert 一致，HTTP 层原样 400）。
 */
export class SqlChannelStore implements ChannelStore {
  constructor(private readonly driver: SqlDriver) {}

  async list(): Promise<NotificationChannelDef[]> {
    const rows = await this.driver.all<{ doc: unknown }>('SELECT doc FROM ddw_channels ORDER BY id');
    return rows.map((r) => structuredClone(this.driver.decodeJson<NotificationChannelDef>(r.doc)));
  }

  async upsert(def: NotificationChannelDef): Promise<void> {
    validateChannelDef(def);
    await this.driver.run(
      this.driver.upsertSql('ddw_channels', 'id', ['doc']),
      [def.id, this.driver.encodeJson(def)],
    );
  }

  async remove(id: string): Promise<boolean> {
    const { affected } = await this.driver.run('DELETE FROM ddw_channels WHERE id = ?', [id]);
    return affected > 0;
  }
}
