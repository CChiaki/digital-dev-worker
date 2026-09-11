import { CAPABILITY_PRESETS, MCP_SET, validateCapabilityDef, type CapabilityDef, type CapabilityStore } from '../../team/capabilities.js';
import type { SqlDriver } from './driver.js';

export type { CapabilityDef } from '../../team/capabilities.js';

/**
 * 能力注册表 SQL 实现（存储企业化 spec §4/§5，T5）：表 ddw_capabilities（kind PK + doc JSON）。
 * 业务规则（validateCapabilityDef 白名单 / CAPABILITY_PRESETS 预置）复用 team/capabilities.ts
 * 导出常量与纯函数，防两实现漂移。upsert 校验在 store 内做（与 FileCapabilityStore.upsert 一致，
 * HTTP 层原样 400）；allowedMcp 动态白名单 getter 同款可选注入（每次 upsert 实时取，server 上下线即生效）。
 */
export class SqlCapabilityStore implements CapabilityStore {
  constructor(
    private readonly driver: SqlDriver,
    private readonly allowedMcp?: () => ReadonlySet<string>,
  ) {}

  async list(): Promise<CapabilityDef[]> {
    const rows = await this.driver.all<{ doc: unknown }>('SELECT doc FROM ddw_capabilities ORDER BY kind');
    return rows.map((r) => structuredClone(this.driver.decodeJson<CapabilityDef>(r.doc)));
  }

  async upsert(def: CapabilityDef): Promise<void> {
    // 每次实时取动态白名单（与 File 实现同源；缺省内置包 forge/deploy）
    validateCapabilityDef(def, this.allowedMcp?.() ?? MCP_SET);
    await this.driver.run(
      this.driver.upsertSql('ddw_capabilities', 'kind', ['doc']),
      [def.kind, this.driver.encodeJson(def)],
    );
  }

  async remove(kind: string): Promise<boolean> {
    const { affected } = await this.driver.run('DELETE FROM ddw_capabilities WHERE kind = ?', [kind]);
    return affected > 0;
  }

  /** 预置四类种子：表非空即跳过（「文件已存在不覆盖」幂等语义的表化对应）；
   *  非空判定与多行写入包同一事务，原子落库。 */
  async ensureSeed(): Promise<void> {
    await this.driver.tx(async () => {
      const rows = await this.driver.all<{ n: unknown }>('SELECT COUNT(*) AS n FROM ddw_capabilities');
      if (Number(rows[0]?.n ?? 0) > 0) return;
      for (const def of CAPABILITY_PRESETS) {
        await this.driver.run(
          this.driver.upsertSql('ddw_capabilities', 'kind', ['doc']),
          [def.kind, this.driver.encodeJson(def)],
        );
      }
    });
  }
}
