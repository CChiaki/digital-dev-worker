import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SqlDriver } from './stores/sql/driver.js';
import { TABLES } from './stores/sql/driver.js';
import { SqliteDriver } from './stores/sql/sqlite-driver.js';
import { createMysqlDriver } from './stores/sql/mysql-driver.js';
import { mysqlUrlFrom } from './http/server.js';
import { parseStorage, type StorageConfig } from './team/runtime-config.js';

/**
 * 一次性迁移命令（存储企业化 Task 8）：存量数据 →Sql 存储目标（sqlite/mysql）。
 * - 源（只读，迁移后原样保留）：旧 sqlite `<dataDir>/ddw.sqlite` 的 task/event 表（node:sqlite 直接
 *   SQL 读，不经 store 类——历史数据不做校验层归一）+ 5 个 JSON 档案
 *   （employees/skills/capabilities/messages/notification-channels，缺文件跳过并在汇总注明）。
 * - 目标：--to 缺省 sqlite（`<dataDir>/ddw.sqlite`；与源同文件即拒绝，sqlite→sqlite 须用
 *   --runtime storage.sqlite.path 指定其他目标路径）；mysql 目标经 --runtime yaml 的 storage.mysql 段
 *   （password 支持 enc:v1: 密文，resolveSecret 解密，与 server.ts mysqlUrlFrom 同一套）。
 *   目标库任一 ddw_ 表有行即拒绝（防重复迁移/误覆盖）。
 * - 导入：单事务逐域直写 8 表窄列 + doc JSON（不走 store 校验层，历史数据原样入库；
 *   JSON 编码经 driver.encodeJson 与运行期写入保持一致）。事件 seq 原值保留——审计 hash 链的
 *   全局序依赖 seq，重排即断链。
 * - 成功落盘 `<dataDir>/migrated-<driver>.marker`（时间戳 + 各域条数）；旧文件不动。
 */

export interface MigrateSummary {
  /** 目标驱动类型（marker 文件名与汇总文案用） */
  target: 'sqlite' | 'mysql';
  /** 各域导入条数 */
  tasks: number;
  events: number;
  employees: number;
  skillCategories: number;
  skills: number;
  capabilities: number;
  messages: number;
  channels: number;
  /** 跳过的源（缺文件/缺表），中文描述 */
  skipped: string[];
  /** 残行跳过条数（无主键/无必备字段的源行：不导入也不静默丢——汇总条数+本值与源行数可对账） */
  skippedRows: number;
  /** 成功标记文件路径 */
  markerPath: string;
}

export interface MigrateOptions {
  /** 源数据目录（旧 sqlite + 5 个 JSON + marker 落盘处） */
  dataDir: string;
  /** 目标驱动；缺省取 --runtime storage 段的 driver，再缺省 sqlite */
  to?: 'sqlite' | 'mysql';
  /** mysql 目标（及 sqlite 目标自定义路径）经 yaml storage 段提供 */
  runtimePath?: string;
  /** 凭据解密环境（缺省 process.env；主密钥 DDW_CRED_KEY） */
  env?: NodeJS.ProcessEnv;
  /** 测试注入目标驱动（如 :memory: sqlite）；提供时忽略 to/runtimePath 的目标解析 */
  targetDriver?: SqlDriver;
}

const LEGACY_JSON_FILES = [
  'employees.json',
  'skills.json',
  'capabilities.json',
  'messages.json',
  'notification-channels.json',
] as const;

/** 旧 sqlite task/event 表的期望列（真实存量库未必全有——按 PRAGMA table_info 交集读，缺列当 NULL） */
const LEGACY_TASK_COLS = ['id', 'pkg', 'status', 'claimed_by', 'claimed_at', 'result', 'plan_progress', 'failed_item_id', 'updated_at'];
const LEGACY_EVENT_COLS = ['seq', 'id', 'ts', 'task_id', 'employee_id', 'type', 'summary', 'payload', 'prev_hash', 'hash', 'hash_version'];

interface LegacyRow { [col: string]: unknown }

/** 旧 sqlite 源读取（task/event 表直 SQL 读）：文件/表缺失返回空 + 说明，损坏上抛 */
function readLegacySqlite(dataDir: string, skipped: string[]): { tasks: LegacyRow[]; events: LegacyRow[] } {
  const path = join(dataDir, 'ddw.sqlite');
  if (!existsSync(path)) {
    skipped.push('旧 sqlite ddw.sqlite（task/event 表）');
    return { tasks: [], events: [] };
  }
  // 只读优先：避免打开 WAL 库触发恢复写；恢复失败（需 checkpoint）再常规打开（与 doctor 同口径）
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    db = new DatabaseSync(path);
  }
  try {
    const tableNames = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    const readTable = (name: string, wantCols: string[]): LegacyRow[] => {
      if (!tableNames.has(name)) {
        skipped.push(`旧 sqlite 表 ${name}`);
        return [];
      }
      const have = new Set(
        (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name),
      );
      const cols = wantCols.filter((c) => have.has(c));
      return db.prepare(`SELECT ${cols.join(', ')} FROM ${name} ORDER BY rowid`).all() as unknown as LegacyRow[];
    };
    return {
      tasks: readTable('task', LEGACY_TASK_COLS),
      events: readTable('event', LEGACY_EVENT_COLS),
    };
  } finally {
    db.close();
  }
}

function readJsonFile(path: string, skipped: string[], label: string): unknown | undefined {
  if (!existsSync(path)) {
    skipped.push(label);
    return undefined;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** JSON 字符串列 → 值对象（encodeJson 前统一 parse；坏 JSON 原样字符串入库，不静默丢数据） */
function jsonValue(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** NULL 透传 + 值经 driver.encodeJson（与 store 层 JSON 编码一致） */
function enc(driver: SqlDriver, v: unknown): unknown {
  return v === null || v === undefined ? null : driver.encodeJson(v);
}

/** yaml 只取 storage 段（迁移配置无需 profiles/routes——parseRuntimeConfig 对那些强校验会误伤） */
function readStorageSection(yamlPath: string): StorageConfig | undefined {
  const raw = parseYaml(readFileSync(yamlPath, 'utf8')) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return undefined;
  return parseStorage(raw.storage);
}

/**
 * 同文件判定（T8 评审 P3）：fs.realpathSync 解析两侧实际路径（符号链接/相对段/大小写外别名全打回
 * 原形）后比较——runtime 显式指向源文件的路径（含指向同一文件的符号链接）也能拦住。
 * 路径不存在时逐级退化：文件不存在用其父目录的 realpath 拼.basename，父目录也不存在退回 resolve
 * （规范化相对段后的字面比较；目标 sqlite 新库文件常见不存在，属正常路径）。
 */
function sameRealPath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      try {
        return join(realpathSync(dirname(p)), basename(p));
      } catch {
        return resolve(p);
      }
    }
  };
  return real(a) === real(b);
}

/** 单事务逐域直写 8 表（窄列 + doc JSON，不经 store 校验层） */
async function importAll(
  driver: SqlDriver,
  src: {
    tasks: LegacyRow[];
    events: LegacyRow[];
    employees?: unknown;
    skillFile?: unknown;
    capabilities?: unknown;
    messages?: unknown;
    channels?: unknown;
  },
  skipped: string[],
): Promise<Omit<MigrateSummary, 'target' | 'markerPath' | 'skipped'>> {
  const now = Date.now();
  let tasks = 0;
  let events = 0;
  let employees = 0;
  let skillCategories = 0;
  let skills = 0;
  let capabilities = 0;
  let messages = 0;
  let channels = 0;
  // 残行计数（T8 评审 P3）：无主键/无必备字段的源行不导入，但绝不静默丢——按域计数进汇总，
  // 各域导入条数 + 残行数与源行数可对账
  const badRows: Record<string, number> = {};
  const skipRow = (domain: string): void => {
    badRows[domain] = (badRows[domain] ?? 0) + 1;
  };

  await driver.tx(async () => {
    // ---- 任务（旧表 task → ddw_tasks）：pkg/result/plan_progress JSON 原值入库 ----
    for (const r of src.tasks) {
      if (r.id === null || r.id === undefined || r.pkg === null || r.pkg === undefined) { skipRow('task'); continue; } // 无主键/无 pkg 的残行不导入（计数进汇总）
      await driver.run(
        'INSERT INTO ddw_tasks (id, status, claimed_by, claimed_at, pkg, result, plan_progress, failed_item_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          r.id,
          r.status ?? 'pending',
          r.claimed_by ?? null,
          r.claimed_at ?? null,
          enc(driver, jsonValue(r.pkg)),
          enc(driver, jsonValue(r.result)),
          enc(driver, jsonValue(r.plan_progress)),
          r.failed_item_id ?? null,
          r.updated_at ?? now,
        ],
      );
      tasks++;
    }

    // ---- 事件（旧表 event → ddw_events）：seq 原值保留（审计链全局序），缺 hash_version 补 1 ----
    for (const r of src.events) {
      if (r.id === null || r.id === undefined) { skipRow('event'); continue; }
      await driver.run(
        'INSERT INTO ddw_events (seq, id, ts, task_id, employee_id, type, summary, payload, prev_hash, hash, hash_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          r.seq ?? null,
          r.id,
          r.ts ?? now,
          r.task_id ?? '',
          r.employee_id ?? '',
          r.type ?? '',
          r.summary ?? '',
          enc(driver, jsonValue(r.payload)),
          r.prev_hash ?? null,
          r.hash ?? null,
          r.hash_version ?? 1,
        ],
      );
      events++;
    }

    // ---- 员工档案（employees.json → ddw_employees）：doc 原样 JSON（不 normalize），enabled 同步窄列 ----
    if (Array.isArray(src.employees)) {
      for (const raw of src.employees) {
        const rec = raw as { id?: unknown; enabled?: unknown };
        if (typeof rec?.id !== 'string' || !rec.id) { skipRow('employee'); continue; }
        await driver.run(
          'INSERT INTO ddw_employees (id, enabled, doc, updated_at) VALUES (?, ?, ?, ?)',
          [rec.id, rec.enabled === false ? 0 : 1, driver.encodeJson(raw), now],
        );
        employees++;
      }
    }

    // ---- Skill 库（skills.json → ddw_skill_categories + ddw_skills）----
    if (src.skillFile !== undefined) {
      const shape = src.skillFile as { categories?: unknown; skills?: unknown };
      if (!Array.isArray(shape.categories) || !Array.isArray(shape.skills)) {
        throw new Error('skills.json 格式错误：应为 { categories: [], skills: [] }');
      }
      for (const raw of shape.categories) {
        const cat = raw as { id?: unknown; name?: unknown };
        if (typeof cat?.id !== 'string' || !cat.id) { skipRow('skill_category'); continue; }
        await driver.run(
          'INSERT INTO ddw_skill_categories (id, name, doc) VALUES (?, ?, ?)',
          [cat.id, typeof cat.name === 'string' && cat.name ? cat.name : cat.id, driver.encodeJson(raw)],
        );
        skillCategories++;
      }
      for (const raw of shape.skills) {
        const rec = raw as { id?: unknown; categoryId?: unknown; status?: unknown };
        if (typeof rec?.id !== 'string' || !rec.id) { skipRow('skill'); continue; }
        // 终审门（review-gate）之前的存量 skill 无 status 字段——当时即生效，补 'approved'（doc 原样不含）
        const status = typeof rec.status === 'string' ? rec.status : 'approved';
        await driver.run(
          'INSERT INTO ddw_skills (id, category_id, status, doc) VALUES (?, ?, ?, ?)',
          [rec.id, rec.categoryId ?? '', status, driver.encodeJson(raw)],
        );
        skills++;
      }
    }

    // ---- 能力注册表（capabilities.json → ddw_capabilities）----
    if (Array.isArray(src.capabilities)) {
      for (const raw of src.capabilities) {
        const def = raw as { kind?: unknown };
        if (typeof def?.kind !== 'string' || !def.kind) { skipRow('capability'); continue; }
        await driver.run('INSERT INTO ddw_capabilities (kind, doc) VALUES (?, ?)', [def.kind, driver.encodeJson(raw)]);
        capabilities++;
      }
    }

    // ---- 消息中心（messages.json → ddw_messages）：read 窄列 = doc.readAt 已读语义 ----
    if (Array.isArray(src.messages)) {
      for (const raw of src.messages) {
        const rec = raw as { id?: unknown; createdAt?: unknown; readAt?: unknown };
        const id = typeof rec?.id === 'string' && rec.id ? rec.id : randomUUID();
        await driver.run(
          'INSERT INTO ddw_messages (id, `read`, created_at, doc) VALUES (?, ?, ?, ?)',
          [id, rec?.readAt !== undefined && rec.readAt !== null ? 1 : 0, rec?.createdAt ?? now, driver.encodeJson(raw)],
        );
        messages++;
      }
    }

    // ---- 通知渠道（notification-channels.json → ddw_channels）：secret 随 doc 原样入库 ----
    if (Array.isArray(src.channels)) {
      for (const raw of src.channels) {
        const def = raw as { id?: unknown };
        if (typeof def?.id !== 'string' || !def.id) { skipRow('channel'); continue; }
        await driver.run('INSERT INTO ddw_channels (id, doc) VALUES (?, ?)', [def.id, driver.encodeJson(raw)]);
        channels++;
      }
    }
  });

  // 残行汇总：按域计数进 skipped（人读）+ skippedRows（机读对账）——各域导入条数 + 残行数 = 源行数
  const skippedRows = Object.values(badRows).reduce((a, b) => a + b, 0);
  if (skippedRows > 0) {
    const detail = Object.entries(badRows).map(([d, n]) => `${d} ${n} 条`).join('，');
    skipped.push(`残行 ${skippedRows} 条（${detail}）`);
  }
  return { tasks, events, employees, skillCategories, skills, capabilities, messages, channels, skippedRows };
}

/** 执行迁移：读源 → 非空校验 → 事务导入 → marker 落盘。失败原样上抛（CLI 转退出码 1）。 */
export async function runMigration(opts: MigrateOptions): Promise<MigrateSummary> {
  const dataDir = resolve(opts.dataDir);
  const env = opts.env ?? process.env;
  const skipped: string[] = [];

  // ---- 目标驱动解析（注入优先；否则按 to/storage 段构造） ----
  const owned = !opts.targetDriver;
  let target: SqlDriver;
  let kind: 'sqlite' | 'mysql';
  if (opts.targetDriver) {
    target = opts.targetDriver;
    kind = opts.to ?? 'sqlite';
  } else {
    const storage = opts.runtimePath ? readStorageSection(opts.runtimePath) : undefined;
    kind = opts.to ?? storage?.driver ?? 'sqlite';
    if (kind === 'mysql') {
      if (storage?.driver !== 'mysql' || !storage.mysql) {
        throw new Error('mysql 目标需 --runtime yaml 提供 storage 段（driver: mysql + host/user/database）');
      }
      target = await createMysqlDriver(mysqlUrlFrom(storage, env));
    } else {
      if (storage && storage.driver !== 'sqlite') {
        throw new Error(`--to sqlite 与 runtime storage.driver=${storage.driver} 不一致，请核对 --runtime 配置`);
      }
      const targetPath = storage?.sqlite?.path ? resolve(storage.sqlite.path) : join(dataDir, 'ddw.sqlite');
      if (sameRealPath(targetPath, join(dataDir, 'ddw.sqlite'))) {
        throw new Error('sqlite 目标与源为同一文件，拒绝迁移（sqlite → sqlite 请用 --runtime storage.sqlite.path 指定其他目标路径）');
      }
      target = new SqliteDriver(targetPath);
    }
  }

  try {
    await target.ensureSchema();
    // ---- 目标非空拒绝：任一 ddw_ 表有行即停（防重复迁移造成主键冲突/重复数据） ----
    for (const t of TABLES) {
      const rows = await target.all<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${t}`);
      if (Number(rows[0]?.n ?? 0) > 0) {
        throw new Error('目标库非空，拒绝迁移（迁移目标必须是空库）');
      }
    }

    // ---- 源读取（缺文件/缺表跳过并注明） ----
    const legacy = readLegacySqlite(dataDir, skipped);
    const employees = readJsonFile(join(dataDir, 'employees.json'), skipped, 'employees.json（员工档案）');
    const skillFile = readJsonFile(join(dataDir, 'skills.json'), skipped, 'skills.json（Skill 库）');
    const capabilities = readJsonFile(join(dataDir, 'capabilities.json'), skipped, 'capabilities.json（能力注册表）');
    const messages = readJsonFile(join(dataDir, 'messages.json'), skipped, 'messages.json（消息中心）');
    const channels = readJsonFile(join(dataDir, 'notification-channels.json'), skipped, 'notification-channels.json（通知渠道）');

    const counts = await importAll(target, { ...legacy, employees, skillFile, capabilities, messages, channels }, skipped);

    // ---- 成功标记（时间戳 + 各域条数；旧文件一律不动） ----
    mkdirSync(dataDir, { recursive: true });
    const markerPath = join(dataDir, `migrated-${kind}.marker`);
    writeFileSync(markerPath, `${JSON.stringify({ migratedAt: new Date().toISOString(), target: kind, ...counts, skipped }, null, 2)}\n`, 'utf8');

    return { target: kind, ...counts, skipped, markerPath };
  } finally {
    if (owned) await target.close().catch(() => undefined);
  }
}
