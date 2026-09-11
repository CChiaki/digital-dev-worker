import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { log } from './logger.js';
import { dirname, join } from 'node:path';
import type { EmployeeProfile } from '@ddw/runtime';
import { encryptSecret, MASTER_KEY_ENV } from './credentials.js';

/** 员工专属模型绑定（一人一模型一 key，2026-09-06 增补）：与 runtime ModelSpec 同构 */
export interface EmployeeModelBinding {
  baseUrl: string;
  apiKey: string;
  model: string;
  api?: 'openai-completions' | 'anthropic-messages';
}

/** 员工档案（后台化，2026-09-06）：capabilities 绑定能力注册表 kind（空=全部可用）。
 *  多岗位（2026-09-07）：roles 为岗位名数组（每项须是已注册岗位 name，至少一项）；
 *  EmployeeProfile.role（runtime，零改动）由 profileOf 取 roles[0] 主岗填充 */
export interface EmployeeRecord {
  id: string;
  name: string;
  roles: string[];
  /** 【退役 2026-09-07】可接任务岗位集合——调度已改按 role 精确匹配岗位；字段原样忽略（旧档读入不炸） */
  skills?: string[];
  /** 能力 kind 绑定：任务项 kind ∈ 此集合才可执行该项；空/缺省 = 全部可用 */
  capabilities: string[];
  /** 【退役 2026-09-07】原 Skill 分类关联——注入已改按岗位；旧数据读入忽略 */
  skillCategories?: string[];
  /** 专属模型（缺省 = 回退全局 routes）；apiKey 支持 enc:v1: 密文 */
  model?: EmployeeModelBinding;
  supervision?: { level: 'shadow' | 'assisted' | 'trusted' };
  /** false = 停用（调度不再分派；不物理删） */
  enabled: boolean;
  createdAt: number;
}

const LEVELS = new Set(['shadow', 'assisted', 'trusted']);

/** roles 逐项 trim 归一（2026-09-08 遗留收尾 T3 员工档案卫生）：非字符串项剔除（脏档不炸 load）、
 *  trim 后空项剔除；剔除后为空数组交给上游语义——输入路径 validateEmployeeRecord 拒绝、
 *  load 路径触发脏档警告（见 FileEmployeeStore.load / SqlEmployeeStore.load） */
export function trimRoles(roles: unknown): string[] {
  if (!Array.isArray(roles)) return [];
  return (roles as unknown[])
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * 入口归一化（终审修复）：前端与 GET 往返的 supervision 是扁平字符串（'shadow' 等），
 * 存储与校验使用 { level } 对象形状——字符串归一化为对象；非法取值仍由 validateEmployeeRecord 拒绝。
 * 其余形状（对象/缺省）原样透传，零回归。
 */
export function normalizeEmployeeInput(rec: EmployeeRecord): EmployeeRecord {
  // 多岗位归一（2026-09-07）：旧单值 role 包装为 roles（兼容旧前端/旧文件提交）；
  // roles 逐项 trim + 空项剔除（2026-09-08 T3）
  const withRoles = (() => {
    const r = rec as EmployeeRecord & { role?: string };
    if (Array.isArray(rec.roles)) return { ...rec, roles: trimRoles(rec.roles) };
    if (typeof r.role === 'string') {
      const { role: _legacy, ...rest } = rec as EmployeeRecord & { role?: string };
      return { ...rest, roles: trimRoles([r.role]) };
    }
    return { ...rec, roles: [] };
  })();
  const s: unknown = (withRoles as { supervision?: unknown }).supervision;
  if (typeof s === 'string') {
    return { ...withRoles, supervision: { level: s as 'shadow' | 'assisted' | 'trusted' } };
  }
  return withRoles;
}

/** upsert 前的形状与取值校验（错误信息可读，HTTP 层原样 400）；白名单由调用方传入。
 *  第三参 roleNames（2026-09-07 岗位即分类）：已注册岗位 name 清单，roles 每项必须引用其一；
 *  skills / skillCategories 已退役——不再参与调度与注入，字段原样忽略（旧数据读入不炸）；
 *  种子导入（seedFrom）新落盘同样不再写这两个键（2026-09-08 遗留收尾 T3），新档干净。 */
export function validateEmployeeRecord(rec: EmployeeRecord, capabilityKinds: string[], roleNames: string[] = []): void {
  if (typeof rec.id !== 'string' || !rec.id.trim()) throw new Error('员工 id 必须是非空字符串');
  if (typeof rec.name !== 'string' || !rec.name.trim()) throw new Error('员工 name 必须是非空字符串');
  // 多岗位（2026-09-07）：至少一项；白名单非空时每项都须是已注册岗位 name
  const roles = rec.roles;
  if (!Array.isArray(roles) || roles.length === 0 || !roles.every((x) => typeof x === 'string' && x.trim())) {
    throw new Error('员工 roles 必须是非空字符串数组且至少挂载一个岗位');
  }
  if (!Array.isArray(rec.capabilities) || !rec.capabilities.every((x) => typeof x === 'string')) {
    throw new Error('员工 capabilities 必须是字符串数组');
  }
  // 白名单仅在注册表已配置时校验（capabilityKinds 空 = 未注入能力注册表，不设限）
  if (capabilityKinds.length > 0) {
    const unknown = rec.capabilities.filter((k) => !capabilityKinds.includes(k));
    if (unknown.length > 0) {
      throw new Error(`员工 capabilities 含未注册的能力: ${unknown.join(', ')}（允许: ${capabilityKinds.join(', ') || '无'}）`);
    }
  }
  // 岗位白名单仅在分类表已配置时校验（roleNames 空 = 未装配 Skill 库/无岗位，不设限）
  if (roleNames.length > 0) {
    const unknownRoles = roles.filter((r) => !roleNames.includes(r));
    if (unknownRoles.length > 0) {
      throw new Error(`员工 roles 含未注册岗位: ${unknownRoles.join(', ')}（必须是已注册岗位: ${roleNames.join(' / ')}，在管理台「Skill 库 → 岗位管理」维护）`);
    }
  }
  if (rec.supervision !== undefined && (rec.supervision === null || typeof rec.supervision !== 'object' || !LEVELS.has(rec.supervision.level))) {
    throw new Error('员工 supervision.level 必须是 shadow | assisted | trusted');
  }
  if (typeof rec.enabled !== 'boolean') throw new Error('员工 enabled 必须是布尔值');
  if (rec.model !== undefined) {
    const m = rec.model;
    if (typeof m.baseUrl !== 'string' || !m.baseUrl.trim()) throw new Error('员工 model.baseUrl 必须是非空字符串');
    if (typeof m.apiKey !== 'string' || !m.apiKey.trim()) throw new Error('员工 model.apiKey 必须是非空字符串');
    if (typeof m.model !== 'string' || !m.model.trim()) throw new Error('员工 model.model 必须是非空字符串');
    if (m.api !== undefined && m.api !== 'openai-completions' && m.api !== 'anthropic-messages') {
      throw new Error('员工 model.api 必须是 openai-completions | anthropic-messages');
    }
  }
}

export interface EmployeeStore {
  list(): Promise<EmployeeRecord[]>;
  get(id: string): Promise<EmployeeRecord | null>;
  upsert(rec: EmployeeRecord): Promise<void>;
  /** 停用/启用（不物理删）；不存在返回 null */
  setEnabled(id: string, enabled: boolean): Promise<EmployeeRecord | null>;
  /** yaml profiles 导入：仅文件不存在时写入（幂等），capabilities 置空、enabled=true */
  seedFrom(profiles: EmployeeProfile[]): Promise<void>;
}

/**
 * 员工专属模型 apiKey 写侧加密（2026-09-11 复盘批，对齐渠道 encryptChannelSecrets）：
 * 明文 → enc:v1: 密文后再落库（幂等——已是密文跳过）；主密钥不在场原样返回
 * （无 DDW_CRED_KEY 环境维持明文现状，用侧 resolveSecret 对明文透传，行为不变）。
 * 入库前调用（handlers POST/PUT + server 启动存量迁移），GET 回显 '***' 不受影响。
 */
export function encryptEmployeeModelKey(rec: EmployeeRecord, env: NodeJS.ProcessEnv = process.env): EmployeeRecord {
  const masterKey = env[MASTER_KEY_ENV];
  if (!masterKey || !rec.model) return rec;
  const k = rec.model.apiKey;
  if (k.startsWith('enc:v1:')) return rec;
  return { ...rec, model: { ...rec.model, apiKey: encryptSecret(k, masterKey) } };
}

/** JSON 文本 → 员工数组（非数组形状抛可读错误，防止 {} / null 进入缓存后报 find is not a function） */
function parseRoster(raw: string): EmployeeRecord[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('员工档案文件格式错误: 应为对象数组');
  return parsed as EmployeeRecord[];
}

/** 旧档兼容（2026-09-07 多岗位）：单值 role 包装为 roles；已在 normalize 链路外兜底（文件直读不经 HTTP 归一）。
 *  归一后剥离旧 role 键——EmployeeRecord 已无此字段，读出的记录不得再带单值残留。
 *  roles 逐项 trim + 空项剔除（2026-09-08 T3）：剔除后为空数组由 load 触发脏档警告 */
export function normalizeStored(rec: EmployeeRecord): EmployeeRecord {
  const { role: legacy, ...rest } = rec as EmployeeRecord & { role?: string };
  if (Array.isArray(rest.roles)) return { ...rest, roles: trimRoles(rest.roles) };
  return { ...rest, roles: trimRoles(typeof legacy === 'string' ? [legacy] : []) };
}

/** 脏档警告文案（2026-09-08 T3，File/Sql store 共用，防两实现漂移）：
 *  roles 空数组 = 无可分派岗位，聚合为一条中文警告；无脏档返回 null（调用方决定告警去重方式——
 *  File 靠 load 缓存天然一次性；Sql 靠已告警 id 集合每进程每条一次） */
export function dirtyEmployeeWarning(records: EmployeeRecord[]): string | null {
  const dirty = records.filter((r) => r.roles.length === 0);
  if (dirty.length === 0) return null;
  return `[员工档案] 脏档警告: 检测到 ${dirty.length} 条 roles 为空的员工记录（无可分派岗位，请在管理台「Skill 库 → 岗位管理」补挂岗位）: ${dirty.map((r) => `${r.id}(${r.name})`).join('、')}`;
}

/** 仅 ENOENT 视为"文件不存在"；其余读/解析错误原样上抛（损坏/权限不得被当作不存在） */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** 员工档案文件实现：单 JSON 文件 + mutate 队列串行化（员工量少读多写少，文件足够） */
export class FileEmployeeStore implements EmployeeStore {
  private cache: EmployeeRecord[] | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async load(): Promise<EmployeeRecord[]> {
    if (this.cache) return this.cache;
    try {
      this.cache = parseRoster(await readFile(this.filePath, 'utf8')).map(normalizeStored);
      // 脏档一次性警告（2026-09-08 T3）：文案与判定抽到 dirtyEmployeeWarning 共用（Sql store 同源）；
      // load 有缓存故每条脏档整个进程生命周期只告警一次
      const warning = dirtyEmployeeWarning(this.cache);
      if (warning) log.warn('store', warning);
    } catch (err) {
      // 仅"文件不存在"视为尚未初始化；损坏/权限等其他读错误原样上抛，
      // 不得静默降级为空表缓存（否则 flush 会把残缺数据写回，覆盖丢失档案）
      if (isEnoent(err)) {
        this.cache = [];
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  private async flush(records: EmployeeRecord[]): Promise<void> {
    this.cache = records;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.employees-${process.pid}.tmp`);
    await writeFile(tmpPath, JSON.stringify(records, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }

  list(): Promise<EmployeeRecord[]> {
    return this.load().then((records) => records.map((r) => structuredClone(r)));
  }

  async get(id: string): Promise<EmployeeRecord | null> {
    const records = await this.load();
    const found = records.find((r) => r.id === id);
    return found ? structuredClone(found) : null;
  }

  upsert(rec: EmployeeRecord): Promise<void> {
    const run = this.queue.then(async () => {
      // 校验由调用方做（store 不重复校验白名单）：此处仅按 id upsert
      const records = await this.load();
      const idx = records.findIndex((r) => r.id === rec.id);
      if (idx >= 0) records[idx] = { ...rec };
      else records.push({ ...rec });
      await this.flush(records);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  setEnabled(id: string, enabled: boolean): Promise<EmployeeRecord | null> {
    const run = this.queue.then(async () => {
      const records = await this.load();
      const found = records.find((r) => r.id === id);
      if (!found) return null;
      found.enabled = enabled; // 停用而非物理删除：历史任务 claimedBy 引用不断
      await this.flush(records);
      return structuredClone(found);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async seedFrom(profiles: EmployeeProfile[]): Promise<void> {
    const run = this.queue.then(async () => {
      let exists = true;
      try {
        // 与 load() 同一判定：读 + 解析 + 形状校验；仅 ENOENT 视为不存在，
        // 损坏/权限/形状错误原样上抛，不得用导入数据覆盖现有档案
        parseRoster(await readFile(this.filePath, 'utf8'));
      } catch (err) {
        if (isEnoent(err)) {
          exists = false;
        } else {
          throw err;
        }
      }
      if (exists) return;
      // capabilities 空 = 全部可用（等价 yaml 时代语义）；enabled 缺省 true
      await this.flush(profiles.map((p) => ({
        id: p.id, name: p.name, roles: [p.role], capabilities: [],
        ...(p.supervision ? { supervision: p.supervision } : {}),
        enabled: true, createdAt: Date.now(),
      })));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
