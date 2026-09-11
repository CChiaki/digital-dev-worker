import type { SqlDriver } from './driver.js';
import { sortableId } from './sortable-id.js';

/** 智能生成记录（2026-09-10 用户需求）：/api/tasks/parse 的输入描述与生成结果留痕（页面暂不展示） */
export interface GenerationRecord {
  id: string;
  /** 用户输入的自然语言需求描述 */
  description: string;
  /** 生成的任务包 yaml（失败时缺省，错误见 error） */
  yaml?: string;
  /** 生成失败原因（成功时缺省） */
  error?: string;
  createdAt: number;
}

export type NewGeneration = Omit<GenerationRecord, 'id' | 'createdAt'>;

/** 只保留最近 500 条，超限丢最旧（生成记录是过程留痕，非审计链） */
const MAX_GENERATIONS = 500;

/** 滚动删除（同表子查询派生表绕 mysql 子查询 LIMIT 限制，两方言通用） */
const ROLLING_DELETE =
  `DELETE FROM ddw_generations WHERE id NOT IN ` +
  `(SELECT id FROM (SELECT id FROM ddw_generations ORDER BY created_at DESC, id DESC LIMIT ${MAX_GENERATIONS}) t)`;

export interface GenerationStore {
  add(rec: NewGeneration): Promise<GenerationRecord>;
  /** 最新在前；limit 缺省 100 */
  list(limit?: number): Promise<GenerationRecord[]>;
}

/**
 * 智能生成记录 SQL 实现：表 ddw_generations（id PK + created_at 窄列 + doc JSON）。
 * insert 与滚动删除包同一事务（模式同 SqlMessageStore）。
 */
export class SqlGenerationStore implements GenerationStore {
  constructor(private readonly driver: SqlDriver) {}

  async add(rec: NewGeneration): Promise<GenerationRecord> {
    return this.driver.tx(async () => {
      const full: GenerationRecord = { ...rec, id: sortableId('gen'), createdAt: Date.now() };
      await this.driver.run(
        'INSERT INTO ddw_generations (id, created_at, doc) VALUES (?, ?, ?)',
        [full.id, full.createdAt, this.driver.encodeJson(full)],
      );
      await this.driver.exec(ROLLING_DELETE);
      return structuredClone(full);
    });
  }

  async list(limit = 100): Promise<GenerationRecord[]> {
    const rows = await this.driver.all<{ doc: unknown }>(
      'SELECT doc FROM ddw_generations ORDER BY created_at DESC, id DESC LIMIT ?',
      [Math.max(1, limit)],
    );
    return rows.map((r) => structuredClone(this.driver.decodeJson<GenerationRecord>(r.doc)));
  }
}
