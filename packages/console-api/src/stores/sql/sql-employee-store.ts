import type { EmployeeProfile } from '@ddw/runtime';
import { dirtyEmployeeWarning, normalizeStored, type EmployeeRecord, type EmployeeStore } from '../../team/employee-store.js';
import type { SqlDriver } from './driver.js';
import { log } from '../../team/logger.js';

export type { EmployeeRecord } from '../../team/employee-store.js';

/**
 * 员工档案 SQL 实现（存储企业化 spec §4/§5，T5）：表 ddw_employees（id PK + enabled 窄列 + doc JSON）。
 * 业务规则（normalizeStored 归一 / 脏档警告文案）复用 team/employee-store.ts 导出纯函数，防两实现漂移：
 * - 读：SELECT doc → decodeJson → normalizeStored（旧单值 role 剥离、roles trim）——与 File 读路径同归一链；
 *   脏档（roles 空）聚合警告，已告警 id 记账，每条每进程一次（等价 File load 缓存的告警一次性语义）。
 * - 写：upsertSql 窄列 enabled 同步写（1/0）；多行写入（seedFrom）与读改写（setEnabled）包 driver.tx。
 * - 校验（validateEmployeeRecord 白名单）由调用方做——store 不重复校验，与 FileEmployeeStore.upsert 一致。
 */
export class SqlEmployeeStore implements EmployeeStore {
  /** 已告警脏档 id（进程内一次性，等价 File load 缓存语义） */
  private readonly warnedDirty = new Set<string>();

  constructor(private readonly driver: SqlDriver) {}

  private toRecord(doc: unknown): EmployeeRecord {
    return normalizeStored(this.driver.decodeJson<EmployeeRecord>(doc));
  }

  /** 读全表（含脏档警告）：File 的 load() 对应物——list/get 共用同一归一与告警链路 */
  private async load(): Promise<EmployeeRecord[]> {
    const rows = await this.driver.all<{ doc: unknown }>('SELECT doc FROM ddw_employees ORDER BY id');
    const records = rows.map((r) => this.toRecord(r.doc));
    const warning = dirtyEmployeeWarning(records.filter((r) => {
      if (r.roles.length > 0 || this.warnedDirty.has(r.id)) return false;
      this.warnedDirty.add(r.id);
      return true;
    }));
    if (warning) log.warn('store', warning);
    return records;
  }

  /** upsert 单条：doc JSON + 窄列 enabled 同步写（updated_at 由库时间戳语义取当下） */
  private async write(rec: EmployeeRecord): Promise<void> {
    await this.driver.run(
      this.driver.upsertSql('ddw_employees', 'id', ['doc', 'updated_at', 'enabled']),
      [rec.id, this.driver.encodeJson(rec), Date.now(), rec.enabled ? 1 : 0],
    );
  }

  async list(): Promise<EmployeeRecord[]> {
    const records = await this.load();
    return records.map((r) => structuredClone(r));
  }

  async get(id: string): Promise<EmployeeRecord | null> {
    const records = await this.load();
    const found = records.find((r) => r.id === id);
    return found ? structuredClone(found) : null;
  }

  async upsert(rec: EmployeeRecord): Promise<void> {
    // 校验由调用方做（store 不重复校验白名单），与 FileEmployeeStore.upsert 同约定
    await this.write(rec);
  }

  /** 停用/启用（不物理删）：doc JSON 整读改写回写 + 窄列同步（JSON_SET 方言差异大，统一读改写+tx）。
   *  不存在返回 null（与 File 语义一致）。 */
  async setEnabled(id: string, enabled: boolean): Promise<EmployeeRecord | null> {
    return this.driver.tx(async () => {
      const rows = await this.driver.all<{ doc: unknown }>('SELECT doc FROM ddw_employees WHERE id = ?', [id]);
      const row = rows[0];
      if (!row) return null;
      const rec = this.toRecord(row.doc);
      rec.enabled = enabled; // 停用而非物理删除：历史任务 claimedBy 引用不断
      await this.write(rec);
      return structuredClone(rec);
    });
  }

  /** yaml profiles 导入：表非空即跳过（「文件已存在不覆盖」幂等语义的表化对应）；
   *  capabilities 空 = 全部可用（等价 yaml 时代语义）、enabled 缺省 true；
   *  非空判定与写入包同一事务，多行写入原子落库。 */
  async seedFrom(profiles: EmployeeProfile[]): Promise<void> {
    await this.driver.tx(async () => {
      const rows = await this.driver.all<{ n: unknown }>('SELECT COUNT(*) AS n FROM ddw_employees');
      if (Number(rows[0]?.n ?? 0) > 0) return;
      for (const p of profiles) {
        await this.write({
          id: p.id, name: p.name, roles: [p.role], capabilities: [],
          ...(p.supervision ? { supervision: p.supervision } : {}),
          enabled: true, createdAt: Date.now(),
        });
      }
    });
  }
}
