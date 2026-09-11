import {
  assertSkillShapeSafe,
  DEFAULT_CATEGORIES,
  type SkillCategory,
  type SkillRecord,
} from '../../team/skill-store.js';
import type { SqlDriver } from './driver.js';

export type { SkillRecord, SkillCategory } from '../../team/skill-store.js';

/**
 * Skill 库 SQL 实现（存储企业化 spec §4/§5，T6）：表 ddw_skill_categories（id PK + name UNIQUE 窄列 +
 * doc JSON）/ ddw_skills（id PK + category_id/status 窄列 + doc JSON）。
 * 业务规则复用 team/skill-store.ts 导出纯函数/常量，防两实现漂移：
 * - upsertSkill 入库形状/assetFiles 路径安全校验下沉（assertSkillShapeSafe，终审 I1）——与 File 实现同源；
 *   categoryId 注册白名单校验（validateSkillRecord）仍由调用方做，与 FileSkillStore.upsertSkill 一致；
 * - ensureSeed 内置五分类：categories 空表时写入（「文件不存在才初始化」幂等语义的表化对应，同
 *   SqlCapabilityStore/SqlEmployeeStore seed 口径），已有数据不覆盖。
 * 与 File 的可感知差异：list 顺序为 id 序（表无自增列，File 的插入序不可恢复），业务消费方不依赖顺序。
 */
export class SqlSkillStore {
  constructor(private readonly driver: SqlDriver) {}

  /** 内置五分类 seed：表非空即跳过（幂等），判定与多行写入包同一事务原子落库 */
  async ensureSeed(): Promise<void> {
    await this.driver.tx(async () => {
      const rows = await this.driver.all<{ n: unknown }>('SELECT COUNT(*) AS n FROM ddw_skill_categories');
      if (Number(rows[0]?.n ?? 0) > 0) return;
      for (const cat of DEFAULT_CATEGORIES) {
        await this.writeCategory(cat);
      }
    });
  }

  private async writeCategory(cat: SkillCategory): Promise<void> {
    await this.driver.run(
      this.driver.upsertSql('ddw_skill_categories', 'id', ['name', 'doc']),
      [cat.id, cat.name, this.driver.encodeJson(cat)],
    );
  }

  async listCategories(): Promise<SkillCategory[]> {
    const rows = await this.driver.all<{ doc: unknown }>('SELECT doc FROM ddw_skill_categories ORDER BY id');
    return rows.map((r) => structuredClone(this.driver.decodeJson<SkillCategory>(r.doc)));
  }

  /** 分类 upsert：name 为业务键必须唯一；同名且 id 不同 → 'name-conflict' 不落库（HTTP 层映射 409），
   *  同 id 改名/重复提交放行——与 FileSkillStore.upsertCategory 同语义 */
  async upsertCategory(cat: SkillCategory): Promise<'upserted' | 'name-conflict'> {
    return this.driver.tx(async () => {
      const dup = await this.driver.all<{ id: string }>(
        'SELECT id FROM ddw_skill_categories WHERE name = ?', [cat.name],
      );
      if (dup[0] && dup[0].id !== cat.id) return 'name-conflict';
      await this.writeCategory(cat);
      return 'upserted';
    });
  }

  /** 返回 'deleted' | 'missing'（不存在）| 'mounted'（仍有 skill 挂载，调用方映射 409） */
  async deleteCategory(id: string): Promise<'deleted' | 'missing' | 'mounted'> {
    return this.driver.tx(async () => {
      const cats = await this.driver.all<{ id: string }>(
        'SELECT id FROM ddw_skill_categories WHERE id = ?', [id],
      );
      if (!cats[0]) return 'missing';
      const mounted = await this.driver.all<{ n: unknown }>(
        'SELECT COUNT(*) AS n FROM ddw_skills WHERE category_id = ?', [id],
      );
      if (Number(mounted[0]?.n ?? 0) > 0) return 'mounted';
      await this.driver.run('DELETE FROM ddw_skill_categories WHERE id = ?', [id]);
      return 'deleted';
    });
  }

  async listSkills(filter?: { status?: string; categoryId?: string }): Promise<SkillRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter?.categoryId) { where.push('category_id = ?'); params.push(filter.categoryId); }
    const sql = `SELECT doc FROM ddw_skills${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
    const rows = await this.driver.all<{ doc: unknown }>(sql, params);
    return rows.map((r) => structuredClone(this.driver.decodeJson<SkillRecord>(r.doc)));
  }

  async getSkill(id: string): Promise<SkillRecord | null> {
    const rows = await this.driver.all<{ doc: unknown }>('SELECT doc FROM ddw_skills WHERE id = ?', [id]);
    const row = rows[0];
    return row ? structuredClone(this.driver.decodeJson<SkillRecord>(row.doc)) : null;
  }

  async upsertSkill(rec: SkillRecord): Promise<void> {
    // store 层防护（终审 I1）：形状/路径安全校验下沉——任何调用方（含 distiller 直调）都拦在落库之前
    assertSkillShapeSafe(rec);
    await this.driver.run(
      this.driver.upsertSql('ddw_skills', 'id', ['category_id', 'status', 'doc']),
      [rec.id, rec.categoryId, rec.status, this.driver.encodeJson(rec)],
    );
  }

  async removeSkill(id: string): Promise<boolean> {
    const { affected } = await this.driver.run('DELETE FROM ddw_skills WHERE id = ?', [id]);
    return affected > 0;
  }

  /** 人工终审：approve/reject（允许改判，重审幂等）；不存在返回 null。
   *  status 窄列与 doc 同步改写（listSkills status 过滤走窄列索引）。
   *  operator（2026-09-11）：终审人（API token 操作者名）写入 doc.reviewedBy 留痕。 */
  async reviewSkill(id: string, action: 'approve' | 'reject', operator?: string): Promise<SkillRecord | null> {
    return this.driver.tx(async () => {
      const rows = await this.driver.all<{ doc: unknown }>('SELECT doc FROM ddw_skills WHERE id = ?', [id]);
      const row = rows[0];
      if (!row) return null;
      const rec = this.driver.decodeJson<SkillRecord>(row.doc);
      rec.status = action === 'approve' ? 'approved' : 'rejected';
      rec.reviewedAt = Date.now();
      if (operator) rec.reviewedBy = operator;
      await this.driver.run(
        'UPDATE ddw_skills SET status = ?, doc = ? WHERE id = ?',
        [rec.status, this.driver.encodeJson(rec), id],
      );
      return structuredClone(rec);
    });
  }

  /** 员工分类 → 生效 skill（仅 approved，注入链路消费）；空分类入参直接返回空（IN () 非法） */
  async skillsForCategories(categoryIds: string[]): Promise<SkillRecord[]> {
    if (categoryIds.length === 0) return [];
    const placeholders = categoryIds.map(() => '?').join(', ');
    const rows = await this.driver.all<{ doc: unknown }>(
      `SELECT doc FROM ddw_skills WHERE status = 'approved' AND category_id IN (${placeholders}) ORDER BY id`,
      categoryIds,
    );
    return rows.map((r) => structuredClone(this.driver.decodeJson<SkillRecord>(r.doc)));
  }
}
