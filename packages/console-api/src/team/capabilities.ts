import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 能力定义（任务项 kind → 工具集映射；后台可配置，2026-09-05） */
export interface CapabilityDef {
  kind: string;
  name: string;
  description?: string;
  /** builtin: 'bash' | 'files'；mcp: 工具包标识（装配器已注册的：'forge' | 'deploy'） */
  tools: { builtin: string[]; mcp: string[] };
  enabled: boolean;
}

/** mcp 工具包标识注册表（新工具包接入 = 此处加标识 + default-tools.ts 加实例工厂，一次性代码接入） */
export const KNOWN_MCP_PACKS = ['forge', 'deploy'] as const;
export const KNOWN_BUILTIN = ['bash', 'files'] as const;

/** 首批四类预置（ensureSeed 写入；后台可改可停可增） */
export const CAPABILITY_PRESETS: CapabilityDef[] = [
  { kind: 'dev', name: '开发编码', description: '阅读、编写、修改代码与文档，构建验证',
    tools: { builtin: ['bash', 'files'], mcp: [] }, enabled: true },
  { kind: 'test', name: '测试验证', description: '运行单元测试、e2e 测试并核对结果',
    tools: { builtin: ['bash', 'files'], mcp: [] }, enabled: true },
  { kind: 'commit', name: '代码提交', description: '建分支、提交文件、创建与查询 MR',
    tools: { builtin: ['files'], mcp: ['forge'] }, enabled: true },
  { kind: 'devops', name: '发布部署', description: '整理发布产物（cp 进产物目录）、传输到目标环境并重启服务',
    tools: { builtin: ['bash', 'files'], mcp: ['deploy'] }, enabled: true },
];

export interface CapabilityStore {
  list(): Promise<CapabilityDef[]>;
  upsert(def: CapabilityDef): Promise<void>;
  remove(kind: string): Promise<boolean>;
  /** 文件不存在时写入预置四类；已存在不覆盖（幂等） */
  ensureSeed(): Promise<void>;
}

const BUILTIN_SET = new Set<string>(KNOWN_BUILTIN);
/** 导出（存储企业化 T5）：SqlCapabilityStore upsert 缺省白名单与 File 实现同源，防两实现漂移 */
export const MCP_SET = new Set<string>(KNOWN_MCP_PACKS);

/**
 * upsert 前的形状与取值校验（错误信息可读，HTTP 层原样 400）。
 * allowedMcp：mcp 标识白名单（2026-09-06 用户需求 B 动态化）——缺省内置包（forge/deploy）；
 * HTTP 层传入「内置包 + McpHub 已连接 server 名」并集，yaml 注册的 server 名即合法标识。
 */
export function validateCapabilityDef(def: CapabilityDef, allowedMcp: ReadonlySet<string> = MCP_SET): void {
  if (typeof def.kind !== 'string' || !def.kind.trim()) throw new Error('能力 kind 必须是非空字符串');
  if (typeof def.name !== 'string' || !def.name.trim()) throw new Error('能力 name 必须是非空字符串');
  if (!Array.isArray(def.tools?.builtin) || !def.tools.builtin.every((x) => typeof x === 'string')) {
    throw new Error('能力 tools.builtin 必须是字符串数组');
  }
  if (!def.tools.builtin.every((x) => BUILTIN_SET.has(x))) {
    throw new Error(`能力 tools.builtin 含未知内置能力: ${def.tools.builtin.filter((x) => !BUILTIN_SET.has(x)).join(', ')}（允许: bash, files）`);
  }
  if (!Array.isArray(def.tools.mcp) || !def.tools.mcp.every((x) => typeof x === 'string')) {
    throw new Error('能力 tools.mcp 必须是字符串数组');
  }
  if (!def.tools.mcp.every((x) => allowedMcp.has(x))) {
    throw new Error(`能力 tools.mcp 含未注册的工具包: ${def.tools.mcp.filter((x) => !allowedMcp.has(x)).join(', ')}（允许: ${[...allowedMcp].join(', ')}）`);
  }
  if (typeof def.enabled !== 'boolean') throw new Error('能力 enabled 必须是布尔值');
}

/** 能力注册表文件实现：单 JSON 文件 + mutate 队列串行化（能力量少读多写少，文件足够） */
/** JSON 文本 → 能力数组（非数组形状抛可读错误，防止 {} / null 进入缓存后报 findIndex is not a function） */
function parseRegistry(raw: string): CapabilityDef[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('能力注册表文件格式错误: 应为对象数组');
  return parsed as CapabilityDef[];
}

/** 仅 ENOENT 视为"文件不存在"；其余读/解析错误原样上抛（损坏/权限不得被当作不存在） */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export class FileCapabilityStore implements CapabilityStore {
  private cache: CapabilityDef[] | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  /** allowedMcp（2026-09-06 用户需求 B，可选）：mcp 标识动态白名单 getter——
   *  server.ts 注入「内置包 + McpHub 已连接 server 名」，缺省静态内置包集合 */
  constructor(
    private readonly filePath: string,
    private readonly allowedMcp?: () => ReadonlySet<string>,
  ) {}

  private async load(): Promise<CapabilityDef[]> {
    if (this.cache) return this.cache;
    try {
      this.cache = parseRegistry(await readFile(this.filePath, 'utf8'));
    } catch (err) {
      // 仅"文件不存在"视为尚未初始化；损坏/权限等其他读错误原样上抛，
      // 不得静默降级为空表缓存（否则 flush 会把残缺数据写回，覆盖丢失注册表）
      if (isEnoent(err)) {
        this.cache = [];
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  private async flush(defs: CapabilityDef[]): Promise<void> {
    this.cache = defs;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.capabilities-${process.pid}.tmp`);
    await writeFile(tmpPath, JSON.stringify(defs, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }

  list(): Promise<CapabilityDef[]> {
    return this.load().then((defs) => defs.map((d) => structuredClone(d)));
  }

  upsert(def: CapabilityDef): Promise<void> {
    const run = this.queue.then(async () => {
      // 每次实时取动态白名单（server 上下线/注册变化即生效）
      validateCapabilityDef(def, this.allowedMcp?.() ?? MCP_SET);
      const defs = await this.load();
      const idx = defs.findIndex((d) => d.kind === def.kind);
      if (idx >= 0) defs[idx] = { ...def };
      else defs.push({ ...def });
      await this.flush(defs);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  remove(kind: string): Promise<boolean> {
    const run = this.queue.then(async () => {
      const defs = await this.load();
      const next = defs.filter((d) => d.kind !== kind);
      if (next.length === defs.length) return false;
      await this.flush(next);
      return true;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async ensureSeed(): Promise<void> {
    const run = this.queue.then(async () => {
      let exists = true;
      try {
        // 与 load() 同一判定：读 + 解析 + 形状校验；仅 ENOENT 视为不存在，
        // 损坏/权限/形状错误原样上抛，不得用预置覆盖现有注册表
        parseRegistry(await readFile(this.filePath, 'utf8'));
      } catch (err) {
        if (isEnoent(err)) {
          exists = false;
        } else {
          throw err;
        }
      }
      if (exists) return;
      await this.flush(CAPABILITY_PRESETS.map((d) => ({ ...d })));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
