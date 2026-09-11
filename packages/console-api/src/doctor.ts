import { mkdir, open, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SqliteDriver } from './stores/sql/sqlite-driver.js';
import { createMysqlDriver } from './stores/sql/mysql-driver.js';
import { mysqlUrlFrom } from './http/server.js';
import { SqlEventStore } from './stores/sql/sql-event-store.js';
import { FileEventStore } from './stores/file-event-store.js';
import { canonicalContent, verifyChain } from './stores/hash-chain.js';
import { loadRuntimeConfig, parseStorage, type StorageConfig } from './team/runtime-config.js';
import { checkMasterKey, MASTER_KEY_ENV } from './team/credentials.js';

/**
 * 交付巡检（P11-T2）：一条命令体检试点机环境——Node 版本/数据目录/存储与审计链/
 * 运行时配置与凭据/bash 白名单/（可选）模型集群连通。
 * 检查函数纯注入化：测试不监听端口、不依赖真实集群；每项输出 ✓/✗ + 明细，任一失败退出码 1。
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorDeps {
  dataDir: string;
  runtimePath?: string;
  /** 模型集群连通探测（内网可达性；缺省关闭） */
  probe?: boolean;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  /** 命令存在性检测（默认 which）；测试注入 stub */
  which?: (cmd: string) => Promise<boolean>;
  /** 连通探测（默认 fetch baseUrl/models，5s 超时；任何 HTTP 响应都算可达） */
  probeModels?: (baseUrl: string) => Promise<void>;
  bashWhitelist?: string[];
  /** 存储配置注入（存储企业化 Task 8）：缺省取 runtime yaml 的 storage 段；注入优先（测试直构免落 yaml）。
   *  提供 = 增加一项「存储连通」巡检（解析校验 + 连通探测）；缺省 = 维持现状（仅缺省 sqlite 路径链校验） */
  storage?: StorageConfig;
}

const whichCmd = (cmd: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile('which', [cmd], (err) => resolve(!err));
  });

const probeDefault = async (baseUrl: string): Promise<void> => {
  const url = new URL('models', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  // 任何 HTTP 响应（含 401/404）都说明网络可达；网络层异常才算失败
  await fetch(url, { signal: AbortSignal.timeout(5000) });
};

/** 比较语义版本 a >= b（'20.5.0' 风格） */
const semverGe = (a: string, b: string): boolean => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
};

/** 判断 runtime yaml 是否实际使用密文凭据：逐行提取 apiKey/password 字段值看前缀（去行内注释，占位符/注释不算） */
export function isCiphertextConfig(yamlText: string): boolean {
  for (const line of yamlText.split('\n')) {
    const code = line.replace(/#.*$/, '');
    const m = code.match(/(?:apiKey|password):\s*["']?([^"'\s,}]+)/);
    if (m && m[1].startsWith('enc:v1:')) return true;
  }
  return false;
}

/** 旧 sqlite 存量库（task/event 单数表，存储企业化前的落库形态）链校验：
 *  同一套 verifyChain 重算（hash_version 缺列按 1）——迁移前 doctor 不再误报「no such table: ddw_events」 */
async function verifyLegacySqliteChain(driver: SqliteDriver): Promise<CheckResult> {
  const name = '存储与审计 hash 链';
  const hasVersion = (await driver.all<{ name: string }>('PRAGMA table_info(event)')).some((c) => c.name === 'hash_version');
  const rows = await driver.all<Record<string, unknown>>(
    `SELECT seq, id, ts, task_id, employee_id, type, summary, payload, prev_hash, hash${hasVersion ? ', hash_version' : ''} FROM event ORDER BY seq ASC`,
  );
  const report = verifyChain(rows.map((r) => ({
    id: String(r.id),
    content: canonicalContent(
      {
        id: String(r.id), ts: Number(r.ts), taskId: String(r.task_id), employeeId: String(r.employee_id),
        type: String(r.type) as never, summary: String(r.summary),
        payload: r.payload ? (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) : null,
      },
      Number(r.hash_version ?? 1),
    ),
    storedHash: r.hash === null ? null : String(r.hash),
    storedPrev: r.prev_hash === null ? null : String(r.prev_hash),
  })));
  return report.ok
    ? { name, ok: true, detail: `sqlite 旧表 event（${report.total} 条事件成链完整，待 migrate 升级新表）` }
    : { name, ok: false, detail: `sqlite 旧表链校验失败：${report.brokenAt ?? '未知断点'}（数据可能被篡改）` };
}

/** 存储与审计链完整性：sqlite 优先，其次 file 实现；无数据 = 首次运行（ok） */
async function checkStorage(dataDir: string): Promise<CheckResult> {  const name = '存储与审计 hash 链';
  const sqlitePath = join(dataDir, 'ddw.sqlite');
  if (existsSync(sqlitePath)) {
    let driver: SqliteDriver | undefined;
    try {
      driver = new SqliteDriver(sqlitePath);
      const tables = await driver.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ddw_events', 'event')",
      );
      const hasNew = tables.some((t) => t.name === 'ddw_events');
      const hasLegacy = tables.some((t) => t.name === 'event');
      if (!hasNew && !hasLegacy) {
        return { name, ok: true, detail: 'sqlite 无事件表（空库，跳过链校验）' };
      }
      // 链头快照路径与 server 落点一致（`<dataDir>/audit-heads.jsonl`，双方言统一）；无快照文件时校验照常通过
      if (hasNew) {
        const store = new SqlEventStore(driver, { headsPath: join(dataDir, 'audit-heads.jsonl') });
        const report = await store.verifyIntegrity();
        if (!report.ok) {
          return { name, ok: false, detail: `sqlite 链校验失败：${report.brokenAt ?? '未知断点'}（数据可能被篡改）` };
        }
        return hasLegacy
          ? { name, ok: true, detail: `sqlite（${report.total} 条事件成链完整；并存在旧表 event 残留，可 migrate 清理）` }
          : { name, ok: true, detail: `sqlite（${report.total} 条事件成链完整）` };
      }
      return await verifyLegacySqliteChain(driver);
    } catch (e) {
      return { name, ok: false, detail: `sqlite 打开失败：${e instanceof Error ? e.message : String(e)}` };
    } finally {
      await driver?.close();
    }
  }
  if (existsSync(join(dataDir, 'events.jsonl'))) {
    // File store 已退出装配（存储企业化 Task 7）：此处仅为存量 file 数据的巡检兜底，
    // 未迁移的旧环境仍能校验其审计链完整性
    try {
      const store = new FileEventStore(dataDir);
      const report = await store.verifyIntegrity();
      return report.ok
        ? { name, ok: true, detail: `file（${report.total} 条事件成链完整）` }
        : { name, ok: false, detail: `file 链校验失败：${report.brokenAt ?? '未知断点'}（数据可能被篡改）` };
    } catch (e) {
      return { name, ok: false, detail: `file 存储读取失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { name, ok: true, detail: '无历史数据（首次运行，跳过链校验）' };
}

/**
 * 存储连通巡检（存储企业化 Task 8）：runtime yaml 提供 storage 段时启用——
 * - sqlite：目标路径目录可写探测（库文件本体首启才创建，不要求已存在）；
 * - mysql：真实建连 + 库存在 + ddw_ 表清单（空库提示「首次启动自动建表」不算失败）。
 * 无 storage 段 = 缺省 sqlite，不输出本项（与既有巡检行为一致）。
 */
async function checkStorageConnectivity(storage: StorageConfig, dataDir: string, env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const name = '存储连通';
  if (storage.driver === 'sqlite') {
    const path = storage.sqlite?.path ? resolve(storage.sqlite.path) : join(dataDir, 'ddw.sqlite');
    try {
      mkdirSync(dirname(path), { recursive: true });
      const probe = `${path}.doctor-probe-${process.pid}`;
      writeFileSync(probe, '');
      rmSync(probe, { force: true });
      return {
        name,
        ok: true,
        detail: `sqlite（${path}${existsSync(path) ? '，库文件已存在' : '，首次启动自动创建'}）目录可写`,
      };
    } catch (e) {
      return { name, ok: false, detail: `${path} 目录不可写（${e instanceof Error ? e.message : String(e)}）` };
    }
  }
  // mysql：连接 + 库存在 + ddw_ 表清单
  const m = storage.mysql!;
  let driver: Awaited<ReturnType<typeof createMysqlDriver>> | undefined;
  try {
    driver = await createMysqlDriver(mysqlUrlFrom(storage, env));
    const dbRows = await driver.all<{ name: string }>(
      'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [m.database],
    );
    if (!dbRows[0]) {
      return { name, ok: false, detail: `连接成功但库 ${m.database} 不存在（请先 CREATE DATABASE ${m.database}）` };
    }
    const tables = await driver.all<{ name: string }>(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE 'ddw_%'",
      [m.database],
    );
    return tables.length === 0
      ? { name, ok: true, detail: `mysql ${m.host}:${m.port ?? 3306}/${m.database} 连通（空库，首次启动自动建表）` }
      : { name, ok: true, detail: `mysql ${m.host}:${m.port ?? 3306}/${m.database} 连通（ddw_ 表 ${tables.length} 张：${tables.map((t) => t.name).join(', ')}）` };
  } catch (e) {
    return { name, ok: false, detail: `mysql ${m.host}:${m.port ?? 3306}/${m.database} 连接失败（${e instanceof Error ? e.message : String(e)}）` };
  } finally {
    await driver?.close().catch(() => undefined);
  }
}

/** 迁移场景 yaml 可能只有 storage 段（无 profiles/routes，完整 parseRuntimeConfig 会失败）——
 *  单独抽 storage 段供连通巡检（解析失败按无段处理，不影响其他巡检项） */
function safeStorageSection(runtimePath?: string): StorageConfig | undefined {
  if (!runtimePath) return undefined;
  try {
    const raw = parseYaml(readFileSync(runtimePath, 'utf8')) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return undefined;
    return parseStorage(raw.storage);
  } catch {
    return undefined;
  }
}

/**
 * 员工模型密钥密文化巡检（2026-09-11 复盘批）：直连存储查 ddw_employees.doc JSON 里
 * model.apiKey 前缀——非 enc:v1: 即明文落库（写入路径 encryptEmployeeModelKey + 启动迁移
 * 正常时不应出现）。表不存在 = 首次运行（ok 跳过）。明文存在时按是否配主密钥给对应补救提示。
 */
async function checkEmployeeKeyCiphertext(storage: StorageConfig, dataDir: string, env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const name = '员工模型密钥密文化';
  let driver: SqliteDriver | Awaited<ReturnType<typeof createMysqlDriver>> | undefined;
  try {
    if (storage.driver === 'sqlite') {
      const path = storage.sqlite?.path ? resolve(storage.sqlite.path) : join(dataDir, 'ddw.sqlite');
      if (!existsSync(path)) return { name, ok: true, detail: 'sqlite 库未创建（首次运行，跳过）' };
      driver = new SqliteDriver(path);
    } else {
      driver = await createMysqlDriver(mysqlUrlFrom(storage, env));
    }
    let rows: { doc: unknown }[];
    try {
      rows = await driver.all<{ doc: unknown }>('SELECT doc FROM ddw_employees');
    } catch {
      return { name, ok: true, detail: '员工表未建（首次运行，跳过）' };
    }
    const plaintext: string[] = [];
    for (const r of rows) {
      const doc = typeof r.doc === 'string' ? (JSON.parse(r.doc) as EmployeeRecordLike) : (r.doc as EmployeeRecordLike);
      if (doc?.model?.apiKey && !doc.model.apiKey.startsWith('enc:v1:')) plaintext.push(String(doc.id ?? '?'));
    }
    return plaintext.length === 0
      ? { name, ok: true, detail: `员工表 ${rows.length} 条，model.apiKey 全部 enc:v1: 密文（或未绑定模型）` }
      : { name, ok: false, detail: `${plaintext.length} 条明文 apiKey（${plaintext.join('、')}）——配好 ${MASTER_KEY_ENV} 后重启服务即自动密文化迁移` };
  } catch (e) {
    // 存储连不上不在此项重复报错（「存储连通」项已有），降级为跳过
    return { name, ok: true, detail: `存储不可达，跳过（${e instanceof Error ? e.message : String(e)}）` };
  } finally {
    await driver?.close().catch(() => undefined);
  }
}

/** 员工 doc JSON 形状（巡检只关心 id + model.apiKey，不引完整 EmployeeRecord 类型防漂移误报） */
interface EmployeeRecordLike {
  id?: string;
  model?: { apiKey?: string };
}

/** 运行全部巡检项 */
export async function runChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const env = deps.env ?? process.env;
  const results: CheckResult[] = [];  // 1. Node 版本（node:sqlite 需 ≥ 20.5）
  const nodeV = deps.nodeVersion ?? process.versions.node;
  results.push(
    semverGe(nodeV, '20.5.0')
      ? { name: 'Node 版本', ok: true, detail: `v${nodeV}（node:sqlite 可用）` }
      : { name: 'Node 版本', ok: false, detail: `v${nodeV} 过低：node:sqlite 需 ≥ 20.5` },
  );

  // 2. 数据目录可写
  {
    const name = '数据目录可写';
    try {
      await mkdir(deps.dataDir, { recursive: true });
      const probe = join(deps.dataDir, `.doctor-probe-${process.pid}`);
      await open(probe, 'w').then((h) => h.close());
      await rm(probe, { force: true });
      results.push({ name, ok: true, detail: deps.dataDir });
    } catch (e) {
      results.push({ name, ok: false, detail: `${deps.dataDir}（${e instanceof Error ? e.message : String(e)}）` });
    }
  }

  // 3. 存储与审计链
  results.push(await checkStorage(deps.dataDir));

  // 4. 运行时配置 + 凭据（提供 --runtime 才检查）
  let config: ReturnType<typeof loadRuntimeConfig> | undefined;
  if (deps.runtimePath) {
    const name = '运行时配置与凭据';
    try {
      config = loadRuntimeConfig(deps.runtimePath, env);
      results.push({
        name,
        ok: true,
        detail: `${config.profiles.length} 名数字员工 / ${config.routes.length} 条模型路由（凭据解密成功）`,
      });
    } catch (e) {
      results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
    // 主密钥仅在配置实际使用密文凭据时为硬性要求；明文/占位符配置不阻塞
    // （P15 演练实测：样例 yaml 的注释与占位符文本含 "enc:v1:" 字样，全文 includes 会误判红）
    let hasCiphertext = true;
    try {
      hasCiphertext = isCiphertextConfig(readFileSync(deps.runtimePath, 'utf8'));
    } catch { /* 读不到原文时保守按密文处理 */ }
    const key = checkMasterKey(env[MASTER_KEY_ENV]);
    results.push({
      name: `主密钥（${MASTER_KEY_ENV}）`,
      ok: key.ok || !hasCiphertext,
      detail: hasCiphertext ? key.detail : `${key.detail}——当前配置为明文凭据，此项不阻塞`,
    });

    // 明文凭据巡检（2026-09-11 P0 安全批）：结构化解析 yaml 后按已知敏感字段路径逐个看前缀，
    // 非 enc:v1: 即明文（占位符/注释不会被 parse 成字段值，比逐行正则可靠）
    {
      const name = '敏感凭据密文化';
      try {
        const raw = parseYaml(readFileSync(deps.runtimePath, 'utf8')) as Record<string, unknown> | null;
        const plaintext: string[] = [];
        const check = (path: string, v: unknown): void => {
          if (typeof v === 'string' && v.trim() && !v.startsWith('enc:v1:')) plaintext.push(path);
        };
        for (const [i, r] of ((raw?.routes as unknown[] | undefined) ?? []).entries()) {
          const ro = r as Record<string, unknown> | undefined;
          check(`routes[${i}].primary.apiKey`, (ro?.primary as Record<string, unknown> | undefined)?.apiKey);
          const fb = ro?.fallback as Record<string, unknown> | undefined;
          if (fb) check(`routes[${i}].fallback.apiKey`, fb.apiKey);
        }
        check('forge.token', (raw?.forge as Record<string, unknown> | undefined)?.token);
        check('storage.mysql.password', (raw?.storage as Record<string, unknown> | undefined)
          && ((raw!.storage as Record<string, unknown>).mysql as Record<string, unknown> | undefined)?.password);
        for (const [i, t] of (((raw?.auth as Record<string, unknown> | undefined)?.tokens as unknown[] | undefined) ?? []).entries()) {
          check(`auth.tokens[${i}].token`, (t as Record<string, unknown> | undefined)?.token);
        }
        results.push(plaintext.length === 0
          ? { name, ok: true, detail: '已知敏感字段全部 enc:v1: 密文（或未配置）' }
          : { name, ok: false, detail: `明文凭据: ${plaintext.join('、')}——用 "cred enc" 加密后回填（主密钥 ${MASTER_KEY_ENV}）` });
      } catch {
        /* yaml 解析失败已由「运行时配置与凭据」项报告，此处不重复 */
      }

      // API 鉴权巡检（2026-09-11）：auth.tokens 配置即启用；未配置 = 控制台 API 裸奔
      try {
        const rawAuth = parseYaml(readFileSync(deps.runtimePath, 'utf8')) as { auth?: { tokens?: unknown[] } } | null;
        const tokens = rawAuth?.auth?.tokens;
        const hasAuth = Array.isArray(tokens) && tokens.length > 0;
        results.push(hasAuth
          ? { name: 'API 鉴权', ok: true, detail: `已启用（${tokens!.length} 个具名 token，Bearer 或 ?token=）` }
          : { name: 'API 鉴权', ok: false, detail: '未配置 auth.tokens——控制台 API 无鉴权，生产环境必须配置（yaml auth 段）' });
      } catch {
        /* 同上 */
      }
    }
  }

  // 4.5 存储连通（存储企业化 Task 8）：runtime yaml 配了 storage 段（或测试注入）才输出本项；
  // 完整 runtime 配置解析失败时仍尝试单取 storage 段（迁移 yaml 只有 storage 段也巡检）；
  // 无段 = 缺省 sqlite，与既有巡检行为一致
  const storage: StorageConfig | undefined = deps.storage ?? config?.storage ?? safeStorageSection(deps.runtimePath);
  if (storage) {
    results.push(await checkStorageConnectivity(storage, deps.dataDir, env));
    // 员工模型密钥密文化（2026-09-11 复盘批）：直查 ddw_employees 存量明文（写入侧已加密 + 启动迁移）
    results.push(await checkEmployeeKeyCiphertext(storage, deps.dataDir, env));
  }

  // 5. bash 白名单命令存在性
  {
    const whitelist = deps.bashWhitelist ?? config?.bashWhitelist ?? ['git', 'node', 'npm', 'npx', 'python3'];
    const which = deps.which ?? whichCmd;
    const missing: string[] = [];
    for (const cmd of whitelist) {
      if (!(await which(cmd))) missing.push(cmd);
    }
    results.push(
      missing.length === 0
        ? { name: 'bash 白名单命令', ok: true, detail: `全部在 PATH：${whitelist.join(', ')}` }
        : { name: 'bash 白名单命令', ok: false, detail: `PATH 中缺失：${missing.join(', ')}（员工执行环境将不可用）` },
    );
  }

  // 6. 模型集群连通（仅 --probe）
  if (deps.probe) {
    const name = '模型集群连通';
    if (!config) {
      results.push({ name, ok: false, detail: '需配合 --runtime 提供模型路由' });
    } else {
      const probe = deps.probeModels ?? probeDefault;
      const seen = new Set<string>();
      const failures: string[] = [];
      for (const r of config.routes) {
        const url = r.primary.baseUrl;
        if (seen.has(url)) continue;
        seen.add(url);
        try {
          await probe(url);
        } catch (e) {
          failures.push(`${url}（${e instanceof Error ? e.message : String(e)}）`);
        }
      }
      results.push(
        failures.length === 0
          ? { name, ok: true, detail: `${seen.size} 个集群端点可达` }
          : { name, ok: false, detail: failures.join('; ') },
      );
    }
  }

  return results;
}

/** 对齐输出巡检报告 */
export function formatChecks(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  return results
    .map((r) => `${r.ok ? '✓' : '✗'} ${r.name.padEnd(width, '　')}  ${r.detail}`)
    .join('\n');
}

/** CLI 入口：打印报告，返回是否全部通过（退出码由 cli 设置） */
export async function runDoctor(deps: DoctorDeps): Promise<boolean> {
  const results = await runChecks(deps);
  const ok = results.every((r) => r.ok);
  console.log('数字AI研发人员 · 交付巡检\n');
  console.log(formatChecks(results));
  console.log(`\n${ok ? '全部通过 ✅' : '存在失败项 ❌（见上 ✗）'}`);
  return ok;
}
