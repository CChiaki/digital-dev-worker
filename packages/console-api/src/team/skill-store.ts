import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/** Skill 类型：knowledge 知识文档 / constraint 开发约束 / asset 可执行资产（附带脚本模板） */
export type SkillType = 'knowledge' | 'constraint' | 'asset';

/** Skill 记录（2026-09-06 Skill 库）：status 仅 review 接口可变（普通 upsert 保留原值） */
export interface SkillRecord {
  id: string;                 // skill-<uuid8>
  categoryId: string;         // 所属技能分类 id
  name: string;
  description: string;
  type: SkillType;
  content: string;            // markdown 正文（knowledge/constraint 即生效内容；asset 为使用说明）
  assetFiles?: { path: string; content: string }[];  // 仅 asset：相对 .skills/<skillId>/ 的文件
  status: 'pending' | 'approved' | 'rejected';
  source: string;             // 'manual' | auto:<taskId>
  sourceTaskId?: string;      // 沉淀来源任务（审查时回看任务上下文）
  createdAt: number;
  reviewedAt?: number;
  /** 终审人（2026-09-11 API token 操作者名；鉴权未启用/历史数据缺省） */
  reviewedBy?: string;
}

export interface SkillCategory { id: string; name: string; description?: string; }

export const SKILL_TYPES = new Set<SkillType>(['knowledge', 'constraint', 'asset']);

/** assetFiles 路径安全校验：禁空、禁绝对路径、禁 .. 路径段（防路径逃逸） */
function assertSafeAssetPath(p: string): void {
  if (!p.trim()) throw new Error('assetFiles.path 不能为空');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw new Error(`assetFiles.path 禁止绝对路径: ${p}`);
  if (p.split('/').includes('..')) throw new Error(`assetFiles.path 禁止包含 ..: ${p}`);
}

/**
 * 形状与路径安全校验（不依赖分类表，进 store 层——终审 I1：distiller 直调 upsertSkill 绕过 HTTP 校验的攻击面）；
 * categoryId 存在性校验仍留给调用方（HTTP 层 400 文案 / distiller 侧 includes 检查）
 */
export function assertSkillShapeSafe(rec: SkillRecord): void {
  if (typeof rec.name !== 'string' || !rec.name.trim()) throw new Error('skill name 必须是非空字符串');
  if (typeof rec.content !== 'string' || !rec.content.trim()) throw new Error('skill content 必须是非空字符串');
  if (!SKILL_TYPES.has(rec.type)) throw new Error('skill type 必须是 knowledge | constraint | asset');
  if (rec.type === 'asset') {
    if (!rec.assetFiles?.length) throw new Error('asset 类型 skill 必须至少附带一个 assetFiles 文件');
    for (const f of rec.assetFiles) assertSafeAssetPath(f.path);
  }
}

/** upsert 前校验（错误可读，HTTP 层原样 400）；categoryIds 为当前注册分类白名单 */
export function validateSkillRecord(rec: SkillRecord, categoryIds: string[]): void {
  assertSkillShapeSafe(rec);
  if (!categoryIds.includes(rec.categoryId)) throw new Error(`skill categoryId 未注册: ${rec.categoryId}`);
}

export function validateSkillCategory(cat: SkillCategory): void {
  if (typeof cat.id !== 'string' || !cat.id.trim()) throw new Error('分类 id 必须是非空字符串');
  if (typeof cat.name !== 'string' || !cat.name.trim()) throw new Error('分类 name 必须是非空字符串');
}

export function newSkillId(): string {
  return `skill-${randomUUID().slice(0, 8)}`;
}

/** 内置分类 seed（2026-09-06）：首启初始化，管理台可增删改 */
export const DEFAULT_CATEGORIES: SkillCategory[] = [
  { id: 'backend', name: '后端开发' },
  { id: 'frontend', name: '前端开发' },
  { id: 'testing', name: '测试' },
  { id: 'devops', name: 'DevOps' },
  { id: 'security', name: '安全合规' },
];

interface SkillFileShape { categories: SkillCategory[]; skills: SkillRecord[]; }

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function parseShape(raw: string): SkillFileShape {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as SkillFileShape).categories) || !Array.isArray((parsed as SkillFileShape).skills)) {
    throw new Error('Skill 库文件格式错误: 应为 { categories: [], skills: [] }');
  }
  return parsed as SkillFileShape;
}

/**
 * Skill 库文件存储：单文件 skills.json（categories + skills），mutate 队列串行化 + tmp 原子写——
 * 与 FileEmployeeStore 同构（缓存、仅 ENOENT 视为不存在、损坏原样上抛）。
 */
export class FileSkillStore {
  private cache: SkillFileShape | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async load(): Promise<SkillFileShape> {
    if (this.cache) return this.cache;
    try {
      this.cache = parseShape(await readFile(this.filePath, 'utf8'));
    } catch (err) {
      // 仅"文件不存在"视为未初始化（内存空表，写入时持久化）；内置分类只由 ensureSeed 首启落盘
      //（load 不得预置 DEFAULT_CATEGORIES——否则首个 upsert 会连带持久化内置分类，破坏 ensureSeed 幂等语义）；
      // 损坏/权限等其他读错误原样上抛，不得静默降级为空表缓存
      if (isEnoent(err)) {
        this.cache = { categories: [], skills: [] };
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  private async flush(shape: SkillFileShape): Promise<void> {
    this.cache = shape;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.skills-${process.pid}.tmp`);
    await writeFile(tmpPath, JSON.stringify(shape, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }

  /** 首启 seed：仅文件不存在时写入内置分类（幂等，已有文件不覆盖） */
  async ensureSeed(): Promise<void> {
    const run = this.queue.then(async () => {
      let exists = true;
      try {
        parseShape(await readFile(this.filePath, 'utf8'));
      } catch (err) {
        if (!isEnoent(err)) throw err;
        exists = false;
      }
      if (exists) return;
      await this.flush({ categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })), skills: [] });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  listCategories(): Promise<SkillCategory[]> {
    return this.load().then((s) => s.categories.map((c) => ({ ...c })));
  }

  /** 岗位 upsert（2026-09-07 岗位即分类）：name 为业务键必须唯一；返回冲突信号由 HTTP 层映射 409 */
  upsertCategory(cat: SkillCategory): Promise<'upserted' | 'name-conflict'> {
    const run = this.queue.then(async (): Promise<'upserted' | 'name-conflict'> => {
      const shape = await this.load();
      // 同名且 id 不同 → 冲突（同 id 重复提交 / 自身改名放行）
      if (shape.categories.some((c) => c.name === cat.name && c.id !== cat.id)) return 'name-conflict';
      const idx = shape.categories.findIndex((c) => c.id === cat.id);
      if (idx >= 0) shape.categories[idx] = { ...cat };
      else shape.categories.push({ ...cat });
      await this.flush(shape);
      return 'upserted';
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 返回 'deleted' | 'missing'（不存在）| 'mounted'（仍有 skill 挂载，调用方映射 409） */
  async deleteCategory(id: string): Promise<'deleted' | 'missing' | 'mounted'> {
    const run = this.queue.then(async (): Promise<'deleted' | 'missing' | 'mounted'> => {
      const shape = await this.load();
      if (!shape.categories.some((c) => c.id === id)) return 'missing';
      if (shape.skills.some((s) => s.categoryId === id)) return 'mounted';
      await this.flush({ ...shape, categories: shape.categories.filter((c) => c.id !== id) });
      return 'deleted';
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async listSkills(filter?: { status?: string; categoryId?: string }): Promise<SkillRecord[]> {
    const shape = await this.load();
    return shape.skills
      .filter((s) => (!filter?.status || s.status === filter.status))
      .filter((s) => (!filter?.categoryId || s.categoryId === filter.categoryId))
      .map((s) => structuredClone(s));
  }

  async getSkill(id: string): Promise<SkillRecord | null> {
    const shape = await this.load();
    const found = shape.skills.find((s) => s.id === id);
    return found ? structuredClone(found) : null;
  }

  upsertSkill(rec: SkillRecord): Promise<void> {
    const run = this.queue.then(async () => {
      // store 层防护（终审 I1）：形状/路径安全校验下沉——任何调用方（含 distiller 直调）都拦在落盘之前
      assertSkillShapeSafe(rec);
      const shape = await this.load();
      const idx = shape.skills.findIndex((s) => s.id === rec.id);
      if (idx >= 0) shape.skills[idx] = structuredClone(rec);
      else shape.skills.push(structuredClone(rec));
      await this.flush(shape);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async removeSkill(id: string): Promise<boolean> {
    const run = this.queue.then(async (): Promise<boolean> => {
      const shape = await this.load();
      if (!shape.skills.some((s) => s.id === id)) return false;
      await this.flush({ ...shape, skills: shape.skills.filter((s) => s.id !== id) });
      return true;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 人工终审：approve/reject（允许改判，重审幂等）；不存在返回 null */
  async reviewSkill(id: string, action: 'approve' | 'reject', operator?: string): Promise<SkillRecord | null> {
    const run = this.queue.then(async (): Promise<SkillRecord | null> => {
      const shape = await this.load();
      const found = shape.skills.find((s) => s.id === id);
      if (!found) return null;
      found.status = action === 'approve' ? 'approved' : 'rejected';
      found.reviewedAt = Date.now();
      if (operator) found.reviewedBy = operator; // 终审人留痕（2026-09-11）
      await this.flush(shape);
      return structuredClone(found);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 员工分类 → 生效 skill（仅 approved，注入链路消费） */
  async skillsForCategories(categoryIds: string[]): Promise<SkillRecord[]> {
    const shape = await this.load();
    const ids = new Set(categoryIds);
    return shape.skills.filter((s) => s.status === 'approved' && ids.has(s.categoryId)).map((s) => structuredClone(s));
  }
}

/**
 * Skill 库存储公共方法面（存储企业化 Task 7）：File/Sql 双实现的共同签名视图——
 * handlers 与 distiller 依赖此抽象而非具体类，装配切换（File 退役 → Sql）业务逻辑零改动。
 */
export type SkillStoreLike = Pick<
  FileSkillStore,
  | 'ensureSeed'
  | 'listCategories'
  | 'upsertCategory'
  | 'deleteCategory'
  | 'listSkills'
  | 'getSkill'
  | 'upsertSkill'
  | 'removeSkill'
  | 'reviewSkill'
  | 'skillsForCategories'
>;
