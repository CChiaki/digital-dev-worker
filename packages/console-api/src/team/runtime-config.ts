import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { EmployeeProfile, RouteConfig } from '@ddw/runtime';
import { resolveSecret } from './credentials.js';
import type { McpServerConfig } from './mcp-hub.js';
import type { YanxunConfig } from './notifier.js';

/**
 * 一体化运行时配置解析（P9-T2）：`--runtime <yaml>` 一体化模式的配置文件。
 * 结构 = examples/console-runtime.example.yaml；错误信息可读（字段路径 + 原因）。
 */
export interface ConsoleRuntimeConfig {
  /** 首启种子员工（2026-09-09 起可省略/为空：纯管理台模式，员工全部后台手动添加） */
  profiles: EmployeeProfile[];
  tickIntervalMs?: number;
  workspaceRoot: string;
  sessionsRoot: string;
  routes: RouteConfig[];
  bashWhitelist?: string[];
  /** 受控 bash 单条命令超时毫秒（缺省 60s）：构建类命令（pnpm install/build）按需放大。
   *  白名单外命令按盯梢等级放权（2026-09-11 三级重构）：shadow/assisted 挂审、trusted 直接执行——
   *  原 bashApproval 全局开关退役（未知 yaml 键静默忽略，旧配置不炸） */
  bashTimeoutMs?: number;
  /** 每任务最大对话轮数（缺省 40，EmployeeRuntime 内置）：达到上限任务以 max_turns 终态优雅退出 */
  maxTurns?: number;
  /** 计划模式每项失败自动重试次数（2026-09-11 P2 产品批，缺省 0 = 失败即停保持现状）：
   *  重试留痕进事件流；耗尽重试才落 failed 即停（后续项 skipped） */
  retryPerItem?: number;
  /** 执行模式（P13）：inproc 单进程（默认）| fork 每任务独立子进程（崩溃隔离） */
  execMode?: 'inproc' | 'fork';
  /** 代码托管协作（可选）：配置后注入 建分支/提交文件/建 MR/查 MR/查文件 工具（provider 决定 GitLab/Gitea） */
  forge?: ForgeConfig;
  /** 发布部署（可选）：产物 → 目标目录 + 重启命令；mcp 工具分档含 'deploy' 时须传 */
  deploy?: DeployConfig;
  /** 标准 MCP server 注册（2026-09-06 用户需求 B）：yaml 注册即接入，tools/list 自动发现，
   *  server 名即能力 tools.mcp 的工具包标识（能力管理界面自动展示，零代码改动） */
  mcpServers?: McpServerConfig[];
  /** 内部燕讯通知接入（2026-09-10 用户需求，可选段）：sendRobotTex 端点 + 报文头固定参数；
   *  配置后「通知渠道」页可建 type=yanxun 渠道（配置机器人 access_token 推送）。 */
  yanxun?: YanxunConfig;
  /** 存储配置（存储企业化 Task 7，可选段）：缺省 sqlite；装配层据此构造唯一 SqlDriver */
  storage?: StorageConfig;
  /** API 鉴权（2026-09-11 P0 安全批，可选段）：tokens 非空即启用——所有 /api/* 请求须带
   *  `Authorization: Bearer <token>`（SSE 等无法设头的场景用 `?token=` query）；
   *  匹配即以 name 作为 operator 注入请求上下文（intervention/config_change 留痕「谁操作的」）。
   *  段缺省 = 鉴权关闭（内网零回归；生产必须配置，doctor 有巡检项兜底） */
  auth?: AuthConfig;
  /** 监听地址绑定（2026-09-11 P0 安全批，可选）：缺省不传 = 全网卡（::）现状；
   *  生产建议显式收口（如 127.0.0.1 只回环 + 反代，或内网段具体 IP） */
  bindHost?: string;
  /** 安全 strict 模式（2026-09-11 用户复盘批，可选）：true 时启动前置检查 fail-safe——
   *  未配 auth 段或未配 bindHost 直接拒绝启动（生产部署 checklist 的机器可读关；
   *  缺省 false = 只打 ERROR 横幅不拦启动，内网试跑零回归） */
  strictMode?: boolean;
  /** 任务级 wall-clock 看门狗（2026-09-11 P0 韧性批，可选）：running 超过此时长 →
   *  failed「任务超时」+ 释放员工；挂审待放行任务 4 倍宽限。缺省 = 关闭（零回归） */
  taskTimeoutMs?: number;
  /** 磁盘治理（2026-09-11 P1 治理批，可选段）：done/failed 任务 workspace 与 session
   *  目录按 mtime TTL 清扫（小时级巡检）。缺省/0 = 关闭；ddw_events 不在此治理范围（审计合规红线） */
  retention?: RetentionConfig;
}

/** 磁盘治理配置：workspaceDays 正整数天；0 = 显式关闭 */
export interface RetentionConfig {
  workspaceDays: number;
}

/** API 鉴权配置（2026-09-11）：具名 token 列表——token 支持 enc:v1: 密文（resolveRuntimeSecrets 解密），
 *  name 即操作者标识（放行人/配置变更人），审计留痕用 */
export interface AuthConfig {
  tokens: { name: string; token: string }[];
}

/** 存储配置（存储企业化 Task 7）：runtime yaml `storage` 段（可选，缺省 sqlite 单文件库）。
 *  password 支持 `enc:v1:` 密文——此处只透传不解密（解密在装配层 server.ts mysqlUrlFrom → resolveSecret，
 *  与 routes apiKey 同一套主密钥 DDW_CRED_KEY） */
export interface StorageConfig {
  driver: 'sqlite' | 'mysql';
  sqlite?: { path?: string };
  /** connectionLimit（2026-09-11 P1 治理批）：连接池上限，缺省 10 */
  mysql?: { host: string; port?: number; user: string; password?: string; database: string; connectionLimit?: number };
}

/** 缺省存储（无 --runtime 或 yaml 未配 storage 段）：sqlite，库文件 `<dataDir>/ddw.sqlite` */
export const DEFAULT_STORAGE: StorageConfig = { driver: 'sqlite' };

/** 代码托管接入配置（provider: gitlab | gitea；token 支持 enc:v1: 密文）。
 *  baseUrl 为服务根地址（如 http://localhost:3000），API 前缀按 provider 自动拼接（/api/v4 或 /api/v1）。 */
export interface ForgeConfig {
  provider: 'gitlab' | 'gitea';
  baseUrl: string;
  token: string;
  /** 发布时自动建仓（2026-09-06）：仓库不存在（not found）且 url 格式完整时用 token 创建；默认关 */
  autoCreateRepo?: boolean;
}

/** 发布部署配置（deploy 段）：产物 → 目标目录 + 重启命令（本版不接 DevOps 平台） */
export interface DeployEnvConfig {
  name: string;
  artifactDir: string;
  restartCommand?: string;
  /** 员工工作区内产物相对路径（缺省 dist） */
  artifactPath?: string;
  /** 配了走 ssh（scp/ssh exec），缺省本机目录直拷 */
  host?: string;
  user?: string;
}
export interface DeployConfig { envs: DeployEnvConfig[]; }

const fail = (field: string, reason: string): never => {
  throw new Error(`运行时配置错误：${field} ${reason}`);
};

const strArray = (field: string, v: unknown, allowEmpty = false): string[] => {
  const empty = Array.isArray(v) && v.length === 0;
  if (!Array.isArray(v) || (empty && !allowEmpty) || !v.every((x) => typeof x === 'string' && x.trim())) {
    fail(field, `必须是非空字符串数组${allowEmpty ? '（可为空数组）' : ''}`);
  }
  return v as string[];
};

/** 校验单一 RouteConfig 形状（callType + primary{baseUrl,apiKey,model,...}） */
function parseRoute(i: number, raw: Record<string, unknown>): RouteConfig {
  const field = `routes[${i}]`;
  if (!raw || typeof raw !== 'object') fail(field, '必须是对象');
  if (!['chat', 'code', 'review', 'test'].includes(raw.callType as string)) {
    fail(`${field}.callType`, `必须是 chat/code/review/test 之一，得到 ${JSON.stringify(raw.callType)}`);
  }
  const primary: unknown = raw.primary;
  if (typeof primary !== 'object' || primary === null) fail(`${field}.primary`, '必须是对象');
  const prim = primary as Record<string, unknown>;
  for (const k of ['baseUrl', 'apiKey', 'model'] as const) {
    const v = prim[k];
    if (typeof v !== 'string' || !v.trim()) fail(`${field}.primary.${k}`, '必须是非空字符串');
  }
  // 协议字段（可选）：缺省 openai-completions；anthropic-messages 走 Anthropic Messages API
  const apiOf = (v: unknown, f: string): void => {
    if (v === undefined) return;
    if (!['openai-completions', 'anthropic-messages'].includes(v as string)) {
      fail(`${f}.api`, `必须是 openai-completions/anthropic-messages 之一，得到 ${JSON.stringify(v)}`);
    }
  };
  // 单请求超时（可选，2026-09-11 P0 韧性批）：正整数毫秒，gateway 侧缺省 120s
  // （ModelSpec.timeoutMs 此前定义了但零消费——本次接线）
  const timeoutOf = (v: unknown, f: string): void => {
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) fail(`${f}.timeoutMs`, '必须是正整数（毫秒）');
  };
  apiOf(prim['api'], `${field}.primary`);
  timeoutOf(prim['timeoutMs'], `${field}.primary`);
  const fb: unknown = raw['fallback'];
  if (fb !== undefined) {
    if (typeof fb !== 'object' || fb === null) fail(`${field}.fallback`, '必须是对象');
    const fbo = fb as Record<string, unknown>;
    for (const k of ['baseUrl', 'apiKey', 'model'] as const) {
      const v = fbo[k];
      if (typeof v !== 'string' || !v.trim()) fail(`${field}.fallback.${k}`, '必须是非空字符串');
    }
    apiOf(fbo['api'], `${field}.fallback`);
    timeoutOf(fbo['timeoutMs'], `${field}.fallback`);
  }
  return raw as unknown as RouteConfig;
}

/** storage 段解析（可选，缺省由装配层取 DEFAULT_STORAGE）：driver 枚举校验；
 *  driver=mysql 时 mysql.host/user/database 必填（中文 fail）；password 支持 enc:v1: 密文透传不解密
 *  （解密在装配层 resolveSecret）。不影响既有解析：yaml 不写 storage 段 = 一切照旧（sqlite）。
 *  导出复用（存储企业化 Task 8）：migrate 命令的目标解析同样只认 storage 段——
 *  迁移 yaml 无需 profiles/routes（parseRuntimeConfig 强校验 those），单取 storage 段。 */
export function parseStorage(raw: unknown): StorageConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') fail('storage', '必须是对象');
  const o = raw as Record<string, unknown>;
  if (!['sqlite', 'mysql'].includes(o.driver as string)) {
    fail('storage.driver', `必须是 sqlite/mysql 之一，得到 ${JSON.stringify(o.driver)}`);
  }
  const driver = o.driver as 'sqlite' | 'mysql';
  // 多余段交叉校验（T7 评审 P3）：driver 与段不匹配 = 配置矛盾，静默忽略会让人误以为生效
  if (driver === 'sqlite' && o.mysql !== undefined) {
    fail('storage.driver', '为 sqlite 时不应配置 mysql 段');
  }
  if (driver === 'mysql' && o.sqlite !== undefined) {
    fail('storage.driver', '为 mysql 时不应配置 sqlite 段');
  }
  if (driver === 'mysql') {
    const m: unknown = o.mysql;
    if (!m || typeof m !== 'object') fail('storage.mysql', '必须是对象（driver=mysql 时必填 host/user/database）');
    const mm = m as Record<string, unknown>;
    for (const k of ['host', 'user', 'database'] as const) {
      const v = mm[k];
      if (typeof v !== 'string' || !v.trim()) fail(`storage.mysql.${k}`, '必须是非空字符串');
    }
    if (mm.port !== undefined && (typeof mm.port !== 'number' || !Number.isInteger(mm.port) || mm.port <= 0)) {
      fail('storage.mysql.port', '必须是正整数');
    }
    if (mm.password !== undefined && typeof mm.password !== 'string') {
      fail('storage.mysql.password', '必须是字符串（支持 enc:v1: 密文）');
    }
    // connectionLimit（2026-09-11）：连接池上限，正整数；缺省驱动内置 10
    if (mm.connectionLimit !== undefined
      && (typeof mm.connectionLimit !== 'number' || !Number.isInteger(mm.connectionLimit) || mm.connectionLimit <= 0)) {
      fail('storage.mysql.connectionLimit', '必须是正整数');
    }
    return {
      driver,
      mysql: {
        host: (mm.host as string).trim(),
        ...(mm.port !== undefined ? { port: mm.port as number } : {}),
        user: (mm.user as string).trim(),
        ...(mm.password !== undefined ? { password: mm.password as string } : {}),
        database: (mm.database as string).trim(),
        ...(mm.connectionLimit !== undefined ? { connectionLimit: mm.connectionLimit as number } : {}),
      },
    };
  }
  // sqlite：path 可选（缺省 `<dataDir>/ddw.sqlite`）
  if (o.sqlite !== undefined) {
    const s: unknown = o.sqlite;
    if (!s || typeof s !== 'object') fail('storage.sqlite', '必须是对象');
    const p = (s as Record<string, unknown>).path;
    if (p !== undefined && (typeof p !== 'string' || !p.trim())) fail('storage.sqlite.path', '必须是非空字符串');
    return { driver, ...(p !== undefined ? { sqlite: { path: p as string } } : {}) };
  }
  return { driver };
}

/** 从 yaml 文本解析一体化运行时配置（CLI / server 组装共用） */
export function parseRuntimeConfig(yamlText: string): ConsoleRuntimeConfig {
  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(yamlText) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`运行时配置错误：yaml 解析失败 — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== 'object') fail('文件内容', '必须是 yaml 映射');

  // profiles 可省略/为空（2026-09-09）：纯管理台模式——员工全部由后台「数字员工」页手动添加，
  // yaml 不再种子。缺省归一为 []，消费端（seedFrom 的 length 守卫）本就兼容空数组
  const profilesRaw: unknown = raw.profiles;
  if (profilesRaw != null && !Array.isArray(profilesRaw)) fail('profiles', '必须是数组（yaml 里留空键也是 null，视同未配置）');
  const profiles: EmployeeProfile[] = ((profilesRaw as unknown[] | undefined) ?? []).map((p: unknown, i: number) => {
    const field = `profiles[${i}]`;
    if (!p || typeof p !== 'object') fail(field, '必须是对象');
    const o = p as Record<string, unknown>;
    for (const k of ['id', 'name', 'role'] as const) {
      const v = o[k];
      if (typeof v !== 'string' || !v.trim()) fail(`${field}.${k}`, '必须是非空字符串');
    }
    const skills = strArray(`${field}.skills`, o.skills);
    const profile: EmployeeProfile = {
      id: (o.id as string).trim(),
      name: (o.name as string).trim(),
      role: (o.role as string).trim(),
      skills,
    };
    if (o.supervision !== undefined) {
      const s = o.supervision as Record<string, unknown>;
      if (!s || typeof s !== 'object') fail(`${field}.supervision`, '必须是对象');
      if (!['shadow', 'assisted', 'trusted'].includes(s.level as string)) {
        fail(`${field}.supervision.level`, `必须是 shadow/assisted/trusted 之一，得到 ${JSON.stringify(s.level)}`);
      }
      // 盯梢三级（2026-09-11 等级放权）：shadow 节点+命令双挂审 / assisted 命令挂审 /
      // trusted 白名单外直接执行；extraCommands 原设计随 resolveBashWhitelist 退役，不再解析
      profile.supervision = { level: s.level as 'shadow' | 'assisted' | 'trusted' };
    }
    return profile;
  });
  const ids = profiles.map((p) => p.id);
  if (new Set(ids).size !== ids.length) fail('profiles[].id', `重复员工 id: ${ids.join(', ')}`);

  // routes 可省略/为空（2026-09-09）：无模型集成模式——控制台/名册/Skill/能力/消息/通知渠道
  // 与 MCP 管理全部可用；任务派发后员工调用模型时才暴露「无路由」错误（gateway 按需报可读信息）
  const routesRaw: unknown = raw.routes;
  if (routesRaw != null && !Array.isArray(routesRaw)) fail('routes', '必须是数组（yaml 里留空键也是 null，视同未配置）');
  const routes: RouteConfig[] = ((routesRaw as unknown[] | undefined) ?? []).map((r: unknown, i: number) => parseRoute(i, r as Record<string, unknown>));
  if (new Set(routes.map((r) => r.callType)).size !== routes.length) fail('routes[].callType', '重复的调用类型路由');

  if (typeof raw.workspaceRoot !== 'string' || !raw.workspaceRoot.trim()) fail('workspaceRoot', '必须是非空字符串');
  if (typeof raw.sessionsRoot !== 'string' || !raw.sessionsRoot.trim()) fail('sessionsRoot', '必须是非空字符串');
  if (raw.tickIntervalMs !== undefined && (typeof raw.tickIntervalMs !== 'number' || raw.tickIntervalMs <= 0)) {
    fail('tickIntervalMs', '必须是正整数（毫秒）');
  }
  if (raw.bashTimeoutMs !== undefined && (typeof raw.bashTimeoutMs !== 'number' || raw.bashTimeoutMs <= 0)) {
    fail('bashTimeoutMs', '必须是正整数（毫秒）');
  }
  if (raw.maxTurns !== undefined && (typeof raw.maxTurns !== 'number' || !Number.isInteger(raw.maxTurns) || raw.maxTurns <= 0)) {
    fail('maxTurns', '必须是正整数（每任务最大对话轮数）');
  }
  // 重试次数允许 0（显式关闭），但不接受负数/小数（计划模式每项失败自动重试）
  if (raw.retryPerItem !== undefined && (typeof raw.retryPerItem !== 'number' || !Number.isInteger(raw.retryPerItem) || raw.retryPerItem < 0)) {
    fail('retryPerItem', '必须是非负整数（计划模式每项失败自动重试次数，0 = 失败即停）');
  }
  if (raw.execMode !== undefined && !['inproc', 'fork'].includes(raw.execMode as string)) {
    fail('execMode', `必须是 inproc/fork 之一，得到 ${JSON.stringify(raw.execMode)}`);
  }

  // storage 段（可选，存储企业化 Task 7）：缺省 sqlite（装配层 DEFAULT_STORAGE）
  const storage = parseStorage(raw.storage);

  // auth 段（可选，2026-09-11 P0 安全批）：tokens 数组（name+token 均非空；token 支持 enc:v1: 密文）。
  // 段存在但 tokens 为空 = 配置矛盾（想开鉴权却没有任何可用 token），直接报错不静默降级
  let auth: AuthConfig | undefined;
  if (raw.auth !== undefined) {
    const a = raw.auth;
    if (!a || typeof a !== 'object') fail('auth', '必须是对象');
    const o = a as Record<string, unknown>;
    const listRaw = o.tokens;
    if (!Array.isArray(listRaw) || listRaw.length === 0) fail('auth.tokens', '必须是非空数组（配置 auth 段即启用鉴权，至少一个 token）');
    const tokens = (listRaw as unknown[]).map((t: unknown, i: number) => {
      const field = `auth.tokens[${i}]`;
      if (!t || typeof t !== 'object') fail(field, '必须是对象');
      const to = t as Record<string, unknown>;
      for (const k of ['name', 'token'] as const) {
        const v = to[k];
        if (typeof v !== 'string' || !v.trim()) fail(`${field}.${k}`, '必须是非空字符串');
      }
      return { name: (to.name as string).trim(), token: (to.token as string).trim() };
    });
    const names = tokens.map((t) => t.name);
    if (new Set(names).size !== names.length) fail('auth.tokens[].name', `重复的操作者名: ${names.join(', ')}`);
    auth = { tokens };
  }

  // bindHost（可选，2026-09-11）：非空字符串（IP 或主机名，server.listen 第二参原样透传）
  if (raw.bindHost !== undefined && (typeof raw.bindHost !== 'string' || !raw.bindHost.trim())) {
    fail('bindHost', '必须是非空字符串（监听地址，如 127.0.0.1）');
  }

  // strictMode（可选，2026-09-11 用户复盘批）：布尔，true = 启动前置安全检查 fail-safe
  if (raw.strictMode !== undefined && typeof raw.strictMode !== 'boolean') {
    fail('strictMode', '必须是布尔值；true 时未配 auth/bindHost 拒绝启动');
  }

  // taskTimeoutMs（可选，2026-09-11 P0 韧性批）：任务级 wall-clock 看门狗上限毫秒。
  // 不配/缺省 = 看门狗关闭（现状零回归）；配置后调度器 30s 巡检 running 超时任务 →
  // failed「任务超时」+ 释放员工（挂审待放行任务 4 倍宽限——等人工不算hang）
  if (raw.taskTimeoutMs !== undefined
    && (typeof raw.taskTimeoutMs !== 'number' || !Number.isInteger(raw.taskTimeoutMs) || raw.taskTimeoutMs <= 0)) {
    fail('taskTimeoutMs', '必须是正整数（毫秒）；不配置 = 关闭看门狗');
  }

  // retention 段（可选，2026-09-11 P1 治理批）：workspaceDays 正整数天（0 = 显式关闭）。
  // 段存在但缺 workspaceDays = 配置矛盾，直接报错（配了治理却无力度 = 误以为生效）
  let retention: RetentionConfig | undefined;
  if (raw.retention !== undefined) {
    const r = raw.retention;
    if (!r || typeof r !== 'object') fail('retention', '必须是对象');
    const w = (r as Record<string, unknown>).workspaceDays;
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 0) {
      fail('retention.workspaceDays', '必须是非负整数（天数；0 = 关闭清扫）');
    }
    retention = { workspaceDays: w as number }; // fail() 抛错后不会走到，断言只为过类型收窄
  }

  // forge 段（可选）：代码托管协作（provider 缺省 gitlab），提供即注入对应工具集
  let forge: ForgeConfig | undefined;
  if (raw.forge !== undefined) {
    const f = raw.forge;
    if (!f || typeof f !== 'object') fail('forge', '必须是对象');
    const o = f as Record<string, unknown>;
    const provider = o.provider === undefined ? 'gitlab' : o.provider;
    if (!['gitlab', 'gitea'].includes(provider as string)) {
      fail('forge.provider', `必须是 gitlab/gitea 之一，得到 ${JSON.stringify(o.provider)}`);
    }
    for (const k of ['baseUrl', 'token'] as const) {
      const v = o[k];
      if (typeof v !== 'string' || !v.trim()) fail(`forge.${k}`, '必须是非空字符串');
    }
    forge = {
      provider: provider as 'gitlab' | 'gitea',
      baseUrl: (o.baseUrl as string).trim(),
      token: (o.token as string).trim(),
      // 发布时自动建仓开关（2026-09-06 用户需求）：默认关，显式 true 才启用
      ...(o.autoCreateRepo === true ? { autoCreateRepo: true } : {}),
    };
  }

  // deploy 段（可选）：发布部署环境列表
  let deploy: DeployConfig | undefined;
  if (raw['deploy'] !== undefined) {
    const d = raw['deploy'];
    if (!d || typeof d !== 'object') fail('deploy', '必须是对象');
    const envsRaw = (d as Record<string, unknown>)['envs'];
    if (!Array.isArray(envsRaw) || envsRaw.length === 0) fail('deploy.envs', '必须是非空数组');
    const envs: DeployEnvConfig[] = (envsRaw as unknown[]).map((e: unknown, i: number) => {
      const field = `deploy.envs[${i}]`;
      if (!e || typeof e !== 'object') fail(field, '必须是对象');
      const o = e as Record<string, unknown>;
      for (const k of ['name', 'artifactDir'] as const) {
        const v = o[k];
        if (typeof v !== 'string' || !v.trim()) fail(`${field}.${k}`, '必须是非空字符串');
      }
      return {
        name: (o['name'] as string).trim(),
        artifactDir: (o['artifactDir'] as string).trim(),
        ...(o['restartCommand'] ? { restartCommand: o['restartCommand'] as string } : {}),
        ...(o['artifactPath'] ? { artifactPath: o['artifactPath'] as string } : {}),
        ...(o['host'] ? { host: o['host'] as string } : {}),
        ...(o['user'] ? { user: o['user'] as string } : {}),
      };
    });
    deploy = { envs };
  }

  // mcpServers 段（可选）：标准 MCP server 注册（stdio：command/args/env；http：url/headers）
  let mcpServers: McpServerConfig[] | undefined;
  if (raw['mcpServers'] !== undefined) {
    const listRaw = raw['mcpServers'];
    if (!Array.isArray(listRaw) || listRaw.length === 0) fail('mcpServers', '必须是非空数组');
    mcpServers = (listRaw as unknown[]).map((s: unknown, i: number) => {
      const field = `mcpServers[${i}]`;
      if (!s || typeof s !== 'object') fail(field, '必须是对象');
      const o = s as Record<string, unknown>;
      if (typeof o.name !== 'string' || !o.name.trim()) fail(`${field}.name`, '必须是非空字符串');
      if (!['stdio', 'http'].includes(o.transport as string)) {
        fail(`${field}.transport`, `必须是 stdio/http 之一，得到 ${JSON.stringify(o.transport)}`);
      }
      const name = (o.name as string).trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        fail(`${field}.name`, `只能是字母/数字/下划线/连字符（用作工具名前缀 mcp_${name}_），得到 ${JSON.stringify(name)}`);
      }
      if (o.transport === 'stdio' && (typeof o.command !== 'string' || !o.command.trim())) {
        fail(`${field}.command`, 'stdio transport 必须提供启动命令');
      }
      if (o.transport === 'http' && (typeof o.url !== 'string' || !o.url.trim())) {
        fail(`${field}.url`, 'http transport 必须提供 MCP 端点 url');
      }
      return {
        name,
        transport: o.transport as 'stdio' | 'http',
        ...(typeof o.command === 'string' ? { command: o.command } : {}),
        ...(Array.isArray(o.args) && o.args.every((x) => typeof x === 'string') ? { args: o.args as string[] } : {}),
        ...(o.env && typeof o.env === 'object'
          ? { env: Object.fromEntries(Object.entries(o.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string> }
          : {}),
        ...(typeof o.url === 'string' ? { url: o.url } : {}),
        ...(o.headers && typeof o.headers === 'object'
          ? { headers: Object.fromEntries(Object.entries(o.headers as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string> }
          : {}),
      };
    });
    const names = mcpServers.map((s) => s.name);
    if (new Set(names).size !== names.length) fail('mcpServers[].name', `重复的 server 名: ${names.join(', ')}`);
  }

  // yanxun 段（可选，2026-09-10 内部燕讯通知）：sendRobotTex 端点 + requestHead 固定参数 +
  // @所有人开关（isAtAll，缺省 false → 报文 '0'）。不配 = 通知渠道页燕讯类型不可推送（发送时报可读错误）
  let yanxun: YanxunConfig | undefined;
  if (raw['yanxun'] !== undefined) {
    const y = raw['yanxun'];
    if (!y || typeof y !== 'object') fail('yanxun', '必须是对象');
    const o = y as Record<string, unknown>;
    if (typeof o.apiUrl !== 'string' || !/^https?:\/\//.test(o.apiUrl)) fail('yanxun.apiUrl', '必须是 http(s) 地址（sendRobotTex 端点）');
    const h: unknown = o.requestHead;
    if (!h || typeof h !== 'object') fail('yanxun.requestHead', '必须是对象（serviceCode/serviceScene/lglBrId/consumerId/orgConsumerId/channelTyp/filFlg）');
    const ho = h as Record<string, unknown>;
    const head = {} as Record<string, string>;
    for (const k of ['serviceCode', 'serviceScene', 'lglBrId', 'consumerId', 'orgConsumerId', 'channelTyp', 'filFlg'] as const) {
      const v = ho[k];
      if (typeof v !== 'string' || !v.trim()) fail(`yanxun.requestHead.${k}`, '必须是非空字符串');
      head[k] = (v as string).trim();
    }
    if (o.isAtAll !== undefined && typeof o.isAtAll !== 'boolean') fail('yanxun.isAtAll', '必须是布尔值（true = 通知 @所有人）');
    yanxun = {
      apiUrl: (o.apiUrl as string).trim(),
      head: head as unknown as YanxunConfig['head'],
      ...(o.isAtAll === true ? { isAtAll: true } : {}),
    };
  }

  return {
    profiles,
    routes,
    workspaceRoot: raw.workspaceRoot as string,
    sessionsRoot: raw.sessionsRoot as string,
    ...(raw.tickIntervalMs !== undefined ? { tickIntervalMs: raw.tickIntervalMs as number } : {}),
    ...(raw.bashWhitelist !== undefined ? { bashWhitelist: strArray('bashWhitelist', raw.bashWhitelist) } : {}),
    ...(raw.bashTimeoutMs !== undefined ? { bashTimeoutMs: raw.bashTimeoutMs as number } : {}),
    ...(raw.maxTurns !== undefined ? { maxTurns: raw.maxTurns as number } : {}),
    ...(raw.retryPerItem !== undefined ? { retryPerItem: raw.retryPerItem as number } : {}),
    ...(raw.execMode !== undefined ? { execMode: raw.execMode as 'inproc' | 'fork' } : {}),
    ...(forge ? { forge } : {}),
    ...(deploy ? { deploy } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(yanxun ? { yanxun } : {}),
    ...(storage ? { storage } : {}),
    ...(auth ? { auth } : {}),
    ...(raw.bindHost !== undefined ? { bindHost: raw.bindHost as string } : {}),
    ...(raw.strictMode !== undefined ? { strictMode: raw.strictMode as boolean } : {}),
    ...(raw.taskTimeoutMs !== undefined ? { taskTimeoutMs: raw.taskTimeoutMs as number } : {}),
    ...(retention ? { retention } : {}),
  };
}

/**
 * 凭据解析（P11-T1）：routes 的 apiKey 支持 `enc:v1:` 密文（AES-256-GCM，主密钥 DDW_CRED_KEY），
 * 明文原样透传（P9 零回归）。密文解密失败 = 启动即失败（不带病运行）。
 */
export function resolveRuntimeSecrets(config: ConsoleRuntimeConfig, env: NodeJS.ProcessEnv = process.env): ConsoleRuntimeConfig {
  // mcpServers 的 headers/env 值支持 enc:v1: 密文（逐值解密，明文原样透传）
  const mcpServers = config.mcpServers?.map((s) => ({
    ...s,
    ...(s.headers ? { headers: Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, resolveSecret(v, env)])) } : {}),
    ...(s.env ? { env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, resolveSecret(v, env)])) } : {}),
  }));
  return {
    ...config,
    routes: config.routes.map((r) => ({ ...r, primary: { ...r.primary, apiKey: resolveSecret(r.primary.apiKey, env) } })),
    ...(config.forge ? { forge: { ...config.forge, token: resolveSecret(config.forge.token, env) } } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    // auth.tokens[].token 支持 enc:v1: 密文（2026-09-11）：逐条解密，明文原样
    ...(config.auth ? { auth: { tokens: config.auth.tokens.map((t) => ({ ...t, token: resolveSecret(t.token, env) })) } } : {}),
  };
}

/** 从 yaml 文件读运行时配置（CLI --runtime 入口；密文 apiKey 在此解密） */
export function loadRuntimeConfig(path: string, env: NodeJS.ProcessEnv = process.env): ConsoleRuntimeConfig {
  return resolveRuntimeSecrets(parseRuntimeConfig(readFileSync(path, 'utf8')), env);
}
