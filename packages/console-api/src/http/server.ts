import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  SqlTaskStore, SqlEventStore, SqlEmployeeStore, SqlCapabilityStore,
  SqlChannelStore, SqlSkillStore, SqlMessageStore, SqlGenerationStore, SqlPushLogStore,
} from '../stores/index.js';
import type { TaskStore, EventStore } from '../stores/index.js';
import type { SqlDriver } from '../stores/sql/driver.js';
import { SqliteDriver } from '../stores/sql/sqlite-driver.js';
import { createMysqlDriver } from '../stores/sql/mysql-driver.js';
import { KNOWN_MCP_PACKS } from '../team/capabilities.js';
import { McpHub } from '../team/mcp-hub.js';
import type { MessageRecord } from '../team/messages.js';
import { pushToChannel, encryptChannelSecrets, localDateTimeString, type ChannelMessage, type NotificationChannelDef } from '../team/notifier.js';
import { wrapEventStoreForMessages, wrapTaskStoreForMessages, type MessageSink } from '../team/message-hub.js';
import { IntegrityMonitor } from '../team/integrity-monitor.js';
import { createRuntimePipeline, type ConsoleRuntimeOptions, type RuntimePipeline } from '../team/pipeline.js';
import { ensureRepoReachable } from '../team/workspace-prepare.js';
import { ManagedRoster } from '../team/managed-roster.js';
import { encryptEmployeeModelKey } from '../team/employee-store.js';
import { resolveSecret } from '../team/credentials.js';
import { DEFAULT_STORAGE, type StorageConfig } from '../team/runtime-config.js';
import { ModelGateway, type EmployeeProfile, type RouteConfig, type TaskPackage } from '@ddw/runtime';
import { parseTaskDescription } from '../team/task-parser.js';
import { createSkillDistiller as distillFromTask } from '../team/skill-distiller.js';
import { createHandlers, type Handlers } from './handlers.js';
import { createSseHandler, createLiveSseHandler, type LiveCounts, type LiveEvent } from './sse.js';
import { ApiGuard } from './guard.js';
import { log, errLine } from '../team/logger.js';
import { listPendingChecks } from '../team/review-gate.js';
import type { AgentEvent } from '@ddw/runtime';

export interface ConsoleServerOptions {
  /** 数据根目录：sqlite 库 `<root>/ddw.sqlite`（storage.sqlite.path 可覆盖）+ 链头快照等库外文件 */
  dataDir: string;
  port?: number;
  /** 一体化运行时（P9-T1）：提供即调度器定时 tick 自动分派；不提供 = 纯控制台（行为与 P8 完全一致）。
   *  存储实现（存储企业化 Task 7）：由 runtime.storage 配置（缺省 sqlite），--store 参数已退役 */
  runtime?: ConsoleRuntimeOptions;
}

/**
 * storage mysql 段 → mysql2 连接 url（存储企业化 Task 7）：
 * `mysql://user:pass@host:port/db`。password 支持 `enc:v1:` 密文（经 resolveSecret 解密，
 * 主密钥 DDW_CRED_KEY 环境变量注入；解密失败 = 启动即失败，不带病运行）。
 */
export function mysqlUrlFrom(storage: StorageConfig, env: NodeJS.ProcessEnv = process.env): string {
  const m = storage.mysql!;
  const password = m.password ? resolveSecret(m.password, env) : '';
  return `mysql://${encodeURIComponent(m.user)}:${encodeURIComponent(password)}@${m.host}:${m.port ?? 3306}/${m.database}`;
}

/** server 上的运行时句柄（stop 便于优雅关闭与测试） */
export interface ConsoleServer extends ReturnType<typeof createServer> {
  __runtime?: RuntimePipeline;
  /** 驱动句柄（2026-09-11 P1 治理批）：优雅停机关池 await 用（'close' 回调里是 fire-and-forget） */
  __driver?: SqlDriver;
}

/**
 * 是否注入 AI 任务解析：仅当运行时路由含 chat 模型路由时具备智能生成。
 * 配了 runtime 但 routes 缺 chat（无模型集成模式）时不注入（handlers 返回 400
 * 「未启用智能生成（未配置模型）」），否则 parseTaskDescription 会抛「未配置的调用类型: chat」。
 */
export function hasChatRoute(routes?: RouteConfig[]): boolean {
  return routes?.some((r) => r.callType === 'chat') ?? false;
}

/** 生产入口：包一层 node:http，将 handler 接到真实端口（启动服务需用户命令，不在测试中调用）。
 *  存储企业化（Task 7）起为 async：mysql 驱动建连 + ensureSchema 完成后才返回（失败终止启动）。 */
export async function startConsoleServer(opts: ConsoleServerOptions): Promise<ConsoleServer> {
  // 唯一 SqlDriver（存储企业化 spec §4）：storage 段配置（缺省 sqlite），8 张表全部经此驱动——
  // FileTaskStore/FileEventStore/File 档案 store 已全部退出装配（类保留，仅供存量数据巡检/迁移）
  const storage = opts.runtime?.storage ?? DEFAULT_STORAGE;
  const dbPath = storage.driver === 'mysql' || !storage.sqlite?.path
    ? join(opts.dataDir, 'ddw.sqlite')
    : resolve(storage.sqlite.path);
  const driver: SqlDriver = storage.driver === 'mysql'
    ? await createMysqlDriver(
      mysqlUrlFrom(storage, process.env),
      // connectionLimit（2026-09-11 P1 治理批）：yaml storage.mysql 段可配，缺省驱动内置 10
      storage.mysql?.connectionLimit !== undefined ? { connectionLimit: storage.mysql.connectionLimit } : {},
    )
    : new SqliteDriver(dbPath);
  // 建表失败必须终止启动（与旧 SqliteTaskStore 构造抛错 = 启动即败的故障模式一致）：
  // 带残缺 schema 的服务起来只会把存储错误扩散到每个请求
  try {
    await driver.ensureSchema();
  } catch (e: unknown) {
    log.error('store', 'schema 初始化失败，终止启动:', errLine(e));
    process.exit(1);
  }
  // 任务池 + 事件流共用同一驱动（表 ddw_tasks/ddw_events）；链头快照统一落
  // `<dataDir>/audit-heads.jsonl`（双方言同名，T7 评审 P3：mysql 分支下 dbPath 缺省名拼接出
  // ddw.sqlite.heads.jsonl 文件名误导，库外存证与具体方言解耦）
  const baseTasks: TaskStore = new SqlTaskStore(driver);
  const baseEvents: EventStore = new SqlEventStore(driver, { headsPath: join(opts.dataDir, 'audit-heads.jsonl') });
  // 启动即建 workspace/sessions 根目录（2026-09-10 用户反馈）：此前仅任务分派时按任务
  // mkdir 兜底，首单分派前两根目录不存在，易被误判为配置未生效；显式建根后路径写错/
  // 无写权限也在启动即暴露，而不是等到第一单失败
  if (opts.runtime) {
    await mkdir(resolve(opts.runtime.workspaceRoot), { recursive: true });
    await mkdir(resolve(opts.runtime.sessionsRoot), { recursive: true });
  }
  // 消息中心（2026-09-06）：事件/任务池装饰器自动生成三类消息（待放行/失败/完成）；
  // sink 落库 + 推送所有启用渠道（消息中心是旁路观测数据：落库/推送失败只记日志，不阻断任务执行流）
  // 实时推送总线（2026-09-10 消息改推送）：sink 落库成功后向 /api/messages/stream 订阅者广播
  const messages = new SqlMessageStore(driver);
  const liveSubs = new Set<(e: LiveEvent) => void>();
  const emitLive = (e: LiveEvent): void => {
    for (const fn of liveSubs) fn(e);
  };
  // 通知渠道（2026-09-06）：钉钉/企微/Webhook/燕讯 后台可配；consoleUrl 用于任务直达链接；
  // yanxun 为内部燕讯接入配置（2026-09-10，runtime yaml yanxun 段）：type=yanxun 渠道推送/测试共用
  const channelStore = new SqlChannelStore(driver);
  // 推送留痕（2026-09-10 用户需求：推送的消息要有记录的地方）：消息 × 渠道逐条落库，
  // 与进程日志（pm2/systemd）同源同信息（含燕讯 seqNo）；留痕失败只记日志不阻断消息流
  const pushLogs = new SqlPushLogStore(driver);
  const consoleUrl = opts.runtime?.consoleUrl;
  const yanxun = opts.runtime?.yanxun;
  // 渠道群发（2026-09-11 P1 治理批从 messageSink 抽出共用）：消息中心消息 / 审计链告警同一条路——
  // per-channel 隔离（try/catch）+ allSettled，失败只记日志，不重试；
  // 成功也留痕（含燕讯 seqNo）——2026-09-10 实测燕讯「收单成功（S）但静默丢投」，
  // 无留痕时收不到消息无从排查（凭 seqNo 全局流水号找平台方定位）；渠道列表读取失败同样留痕
  const fanoutToChannels = async (m: ChannelMessage, messageId: string, noLink = false): Promise<void> => {
    // 通知要素补齐（2026-09-11 用户需求）：每条通知要一眼回答——哪个数字员工、哪个任务、
    // 什么时间点、触发了什么。taskId→任务标题、employeeId→员工显示名查档补齐
    // （查不到回退 id/缺行，不阻断推送）；时间点 = 推送时刻（事件落库与推送同秒级）
    const [taskRec, empRec] = await Promise.all([
      tasks.get(m.taskId).catch(() => undefined),
      m.employeeId ? employeeStore.get(m.employeeId).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    const enriched: ChannelMessage = {
      ...m,
      ...(taskRec ? { taskTitle: taskRec.pkg.title } : {}),
      ...(empRec ? { employeeName: empRec.name } : {}),
      at: localDateTimeString(),
    };
    let channels: NotificationChannelDef[] = [];
    try {
      channels = (await channelStore.list()).filter((c) => c.enabled);
    } catch (e) {
      log.error('notifier', '渠道列表读取失败，跳过推送:', errLine(e));
    }
    await Promise.allSettled(channels.map(async (c) => {
      const base = { messageId, taskId: m.taskId, messageTitle: m.title, channelId: c.id, channelType: c.type, channelName: c.name };
      try {
        // noLink：审计链告警等无任务直达语义的消息不拼 `${consoleUrl}/tasks/:id`（链接会指到不存在的页面）
        const r = await pushToChannel(c, enriched, noLink ? undefined : consoleUrl, 10_000, yanxun);
        log.info('notifier', `已推送 ${m.type} → ${c.id}（${c.type}）${r.yanxunSeqNo ? ` seqNo=${r.yanxunSeqNo}` : ''}`);
        // 推送留痕（2026-09-10）：sent + 燕讯流水号；写库失败只记日志（留痕是旁路数据）
        await pushLogs.add({ ...base, status: 'sent', ...(r.yanxunSeqNo ? { yanxunSeqNo: r.yanxunSeqNo } : {}) })
          .catch((e: unknown) => log.error('push-log', '留痕失败:', errLine(e)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error('notifier', `推送失败 ${m.type} → ${c.id}（${c.type}）:`, msg);
        await pushLogs.add({ ...base, status: 'failed', error: msg })
          .catch((e2: unknown) => log.error('push-log', '留痕失败:', errLine(e2)));
      }
    }));
  };
  const messageSink: MessageSink = {
    onMessage: async (m) => {
      // 落库失败吞错（旁路观测数据不得阻断任务执行流）；失败时不推送（无落库记录）
      let rec: MessageRecord;
      try {
        rec = await messages.add(m);
      } catch (e) {
        log.error('messages', '消息落库失败:', errLine(e));
        return;
      }
      // 实时推送（2026-09-10）：新消息广播给 SSE 订阅者（counts 由 handler 侧重算推送）
      emitLive({ kind: 'message', message: rec });
      await fanoutToChannels(rec, rec.id);
    },
  };
  const tasks = wrapTaskStoreForMessages(baseTasks, messageSink);
  // 事件装饰器旁路钩子（2026-09-10 用户反馈角标消退还慢）：放行裁决（intervention）事件
  // 落库不生成消息、也就不触发总线重算——放行接口的 notifyCounts 跑在裁决事件落库之前，
  // 角标要等 60s 周期对账才消退。裁决落库即时重算，消除延迟
  const events = wrapEventStoreForMessages(baseEvents, messageSink, (e: AgentEvent) => {
    if (e.type === 'intervention' && typeof (e.payload as { approved?: boolean } | undefined)?.approved === 'boolean') {
      emitLive({ kind: 'counts' });
    }
  });
  // 审计链完整性定时校验（2026-09-11 P1 治理批）：启动 + 每日全链重算，结果驻内存供
  // /api/audit 附带（前端徽标）；校验失败告警群发全部启用渠道（不拼任务直达链接）
  const integrityMonitor = new IntegrityMonitor(events, async (s) => {
    await fanoutToChannels({
      type: 'audit_alarm',
      title: '[审计告警] 事件链完整性校验失败',
      summary: `共 ${s.total} 条，首个断点事件 ${s.brokenAt ?? '未知'}——请立即登录控制台核查审计台账（疑似篡改或落盘损坏）`,
      taskId: 'audit',
    }, `integrity-${s.at}`, true);
  });
  // 智能生成记录（2026-09-10 用户需求）：/api/tasks/parse 输入与结果留痕（页面暂不展示）
  const generations = new SqlGenerationStore(driver);
  // 实时角标计数（2026-09-10）：消息未读 / 待放行节点 / Skill 待审查——SSE counts 事件数据源。
  // 待审数按任务存活过滤（2026-09-10 用户反馈角标数值不对）：执行结束任务的残留待审
  // （resolver 已消亡，放行必 404）不再计入；events 用 baseEvents（与 /api/checks 同源同口径）
  const liveCounts = async (): Promise<LiveCounts> => ({
    unread: await messages.unreadCount(),
    checksPending: (await listPendingChecks(baseEvents, baseTasks)).length,
    skillsPending: (await skillStore.listSkills()).filter((s) => s.status === 'pending').length,
  });
  // 能力注册表（2026-09-05）：seed 异步触发不阻塞启动；
  // 读路径容忍暂空（list 返回空数组时 GET 显示空表，seed 毫秒级完成）
  // mcp 标识动态白名单（2026-09-06 用户需求 B）：内置包 + 已注册 MCP server 名——
  // getter 形式，server 连接完成（后台 start）后 serverNames 即包含新清单
  const allowedMcp = (): ReadonlySet<string> => new Set([...KNOWN_MCP_PACKS, ...(mcpHub?.serverNames() ?? [])]);
  const capabilities = new SqlCapabilityStore(driver, allowedMcp);
  // Skill 库（2026-09-06）：内置五分类 seed 异步触发不阻塞启动（表非空即跳过）
  const skillStore = new SqlSkillStore(driver);
  // 员工档案（2026-09-06 后台化）：EmployeeStore 为调度名册唯一事实源。
  // yaml profiles 仅作首次 seed（表空时导入，幂等），之后后台增删改即生效（无需重启）
  const employeeStore = new SqlEmployeeStore(driver);
  // seed（表空即写，幂等）：三段共用同一 SqlDriver——node:sqlite 单连接上事务不可并发
  // （并发 BEGIN = 「cannot start a transaction within a transaction」，2026-09-08 Task 7 集成实测），
  // 必须 串行 执行；串行 + await 在 ensureSchema 之后（同为毫秒级，listen 前完成），
  // 同时消除 seed 事务与启动后首批请求事务的并发冲突。各段独立 catch（一段失败不影响其余）。
  // seed 失败只记日志不终止启动：表空服务仍可用（GET 显示空表，后台可补建）
  try { await capabilities.ensureSeed(); } catch (err: unknown) {
    log.error('capabilities', 'seed 失败:', errLine(err));
  }
  try { await skillStore.ensureSeed(); } catch (err: unknown) {
    log.error('skills', 'seed 失败:', errLine(err));
  }
  if (opts.runtime?.profiles?.length) {
    try { await employeeStore.seedFrom(opts.runtime.profiles); } catch (err: unknown) {
      log.error('employees', 'seed 失败:', errLine(err));
    }
  }
  // 存量渠道凭据密文迁移（2026-09-11 P0 安全批）：主密钥在场时启动即把库里明文
  // secret/token 翻写为 enc:v1:（幂等——已密文跳过）；无主密钥维持明文现状（发送侧
  // resolveChannelSecrets 对明文原样透传，行为不变）。失败只记日志不阻塞启动
  try {
    const changed = (await channelStore.list()).filter((c) => {
      const enc = encryptChannelSecrets(c);
      return enc.secret !== c.secret || enc.token !== c.token;
    });
    for (const c of changed) await channelStore.upsert(encryptChannelSecrets(c));
    if (changed.length > 0) log.info('channels', `存量明文凭据已密文化迁移 ${changed.length} 条`);
  } catch (err: unknown) {
    log.error('channels', '凭据密文迁移失败（不阻塞启动）:', errLine(err));
  }
  // 存量员工模型 apiKey 密文化迁移（2026-09-11 复盘批，对齐渠道迁移）：主密钥在场时启动即把
  // ddw_employees 存量明文 model.apiKey 翻写为 enc:v1:（幂等——已密文跳过）；无主密钥维持明文
  // 现状（用侧 resolveSecret 对明文透传，行为不变）。失败只记日志不阻塞启动
  try {
    const changed = (await employeeStore.list()).filter((r) =>
      encryptEmployeeModelKey(r).model?.apiKey !== r.model?.apiKey);
    for (const r of changed) await employeeStore.upsert(encryptEmployeeModelKey(r));
    if (changed.length > 0) log.info('employees', `存量员工模型 apiKey 已密文化迁移 ${changed.length} 条`);
  } catch (err: unknown) {
    log.error('employees', '员工模型 apiKey 密文迁移失败（不阻塞启动）:', errLine(err));
  }
  // 员工专属模型（2026-09-06 一人一模型一 key）：modelOf 基于 tick refresh 快照，同步取；
  // apiKey 支持 enc:v1: 密文（credentials.ts resolveSecret），执行前解密
  const managedRoster = new ManagedRoster(employeeStore);
  // 标准 MCP server 连接池（2026-09-06 用户需求 B）：yaml mcpServers 注册即接入——
  // 后台启动连接 + tools/list 自动发现（不阻塞 listen）；server 名即能力 mcp 工具包标识
  const mcpHub = opts.runtime?.mcpServers?.length ? new McpHub(opts.runtime.mcpServers) : undefined;
  if (mcpHub) {
    void mcpHub.start().then(() => {
      const statuses = mcpHub.statuses().map((s) => `${s.name}(${s.status},${s.tools.length} 工具)`).join(' ');
      log.info('mcp-hub', 'server 状态:', statuses || '无');
    });
  }
  // AI 解析（2026-09-06）：一体机模式配了 chat 模型路由即具备智能生成（解析自然语言 → 任务包 yaml）；
  // routes 缺 chat（无模型集成模式）不注入，保持 handlers 400「未启用智能生成（未配置模型）」文案。
  // 声明位置在 pipeline 之前（2026-09-06 蒸馏钩子需要 gateway 引用，整体上移）
  const gateway =
    opts.runtime && hasChatRoute(opts.runtime.routes) ? new ModelGateway(opts.runtime.routes) : undefined;
  // 一体化模式（2026-09-05 计划模式）：能力定义 provider 注入执行链（inproc 分派时取最新；
  // fork 由 process-executor 分派时取快照随 job 下发），deploy 由 runtime yaml 解析结果随 opts.runtime 带入
  const pipeline = opts.runtime
    ? createRuntimePipeline({ tasks, events }, {
        ...opts.runtime,
        capabilities: () => capabilities.list(),
        ...(mcpHub ? { mcpHub, mcpServers: opts.runtime?.mcpServers } : {}),
        // 蒸馏沉淀钩子（2026-09-06）：任务成功完成后异步蒸馏候选 Skill（pending 入库 + 消息中心）；
        // events 用消息装饰器包装后的 store——蒸馏留痕事件自动生成 skill_pending 消息；
        // 终审修复（2026-09-06）：createSkillDistiller 是「(deps) => (input) => Promise」两段工厂，
        // 此前一次调用传两参导致返回未执行的闭包——生产蒸馏从未真正跑起（tsc 亦报 TS2554）。
        // 整体 catch 兜底：蒸馏链路任何未捕获异常只记日志，绝不影响任务终态
        ...(opts.runtime && skillStore && gateway
          ? {
              onTaskComplete: (task: TaskPackage, employee: EmployeeProfile): void => {
                void distillFromTask({ gateway, skillStore, events, workspaceRoot: opts.runtime!.workspaceRoot })({ task, employee })
                  .catch((e: unknown) => {
                    log.error('skill-distiller', '蒸馏失败:', errLine(e));
                  });
              },
            }
          : {}),
        // Skill 注入接线（2026-09-06 终审 C1；2026-09-07 岗位即分类改造）：员工 role（岗位名）→ 按 name 查分类
        // → 该分类 approved skills；岗位无对应分类（被删/未建）→ 空清单不抛错（fork 链路在分派时取快照）
        // 多岗位注入（2026-09-07）：任务岗位 ∈ 员工 roles → 只取该岗位 skill（精准）；
        // 任务无岗位 / 点名分派岗位不在集合 → 全岗位并集兜底（防裸奔）
        skillsFor: async (id: string, taskRole?: string) => {
          const rec = await employeeStore.get(id);
          if (!rec) return [];
          const cats = await skillStore.listCategories();
          const byName = (name: string) => cats.find((c) => c.name === name);
          const role = taskRole?.trim(); // 注入口径与调度 trim 收口对齐（2026-09-08 观察项清理）
          const targetRoles = role && rec.roles.includes(role) ? [role] : rec.roles;
          const catIds = targetRoles.map(byName).filter((c): c is NonNullable<typeof c> => !!c).map((c) => c.id);
          return skillStore.skillsForCategories(catIds);
        },
        // 调度名册/分派过滤/每 tick 刷新/员工专属模型：员工档案后台化接线（2026-09-06）
        roster: managedRoster,
        canDispatch: (task, employee) => managedRoster.canDispatch(task, employee),
        onBeforeTick: () => managedRoster.refresh(),
        modelFor: (id) => {
          const m = managedRoster.modelOf(id);
          return m ? { ...m, apiKey: resolveSecret(m.apiKey, process.env) } : undefined;
        },
      })
    : undefined;
  const handle: Handlers = createHandlers({
    tasks,
    events,
    capabilities,
    ...(mcpHub ? { mcpHub } : {}),
    messages, // 消息中心（2026-09-06）：FileMessageStore 已创建但此前漏传 → GET /api/messages 恒 400
    pushLogs, // 推送留痕（2026-09-10 用户需求）：/api/push-logs 查询接口
    generations, // 智能生成记录（2026-09-10）：parse 留痕 + /api/generations
    notifyCounts: () => emitLive({ kind: 'counts' }), // 角标变更 → SSE 重算推送
    channels: channelStore, // /api/notification-channels CRUD + 测试消息（2026-09-06）
    integrityMonitor, // 审计链定时校验（2026-09-11 P1 治理批）：/api/audit 附带最近结果 + POST verify
    yanxun, // 燕讯接入（2026-09-10）：type=yanxun 渠道测试消息用
    consoleUrl,
    employeeStore, // /api/employees 走 CRUD（2026-09-06 后台化）；只读 profiles 回退分支保留在 handlers
    skills: skillStore, // /api/skill-categories + /api/skills CRUD + 人工终审（2026-09-06）
    ...(pipeline ? { reviewQueue: pipeline.reviewQueue } : {}),
    // 强制重置在途中性化（2026-09-11 P0 韧性批）：scheduler.abandon（迟到回写守卫 + 释放占用）
    ...(pipeline ? { onForceReset: (taskId: string, claimedBy?: string) => pipeline.scheduler.abandon(taskId, claimedBy) } : {}),
    // 发布前仓库可达性校验（2026-09-06 实战修复）：配了 forge 才注入（token 认证 ls-remote 探测）
    ...(opts.runtime?.forge
      ? { repoCheck: (url: string) => ensureRepoReachable(url, opts.runtime?.forge) }
      : {}),
    ...(gateway
      ? {
          taskParser: async (description: string) => ({
            yaml: await parseTaskDescription(gateway, description, async () =>
              (await capabilities.list()).filter((c) => c.enabled).map((c) => c.kind),
              // 能力矩阵 + MCP 已发现工具（2026-09-10）：注入生成提示词，detail 优先落到
              // 已接入能力/MCP 工具（如 jenkins 触发构建），不再自编 REST API 方案
              async () => ({
                caps: (await capabilities.list()).filter((c) => c.enabled).map((c) => ({
                  kind: c.kind, name: c.name, description: c.description,
                  builtin: c.tools.builtin, mcp: c.tools.mcp,
                })),
                mcpTools: (mcpHub?.statuses() ?? [])
                  .filter((s) => s.status === 'connected')
                  .map((s) => ({ server: s.name, tools: s.tools })),
              })),
          }),
        }
      : {}),
  });

  // API 准入闸（2026-09-11 P0 安全批）：token 鉴权（auth.tokens 配置即启用）+ 请求体上限 + 按 IP 限流
  const guard = new ApiGuard({ tokens: opts.runtime?.auth?.tokens });

  // 启动孤儿扫描（2026-09-11 P0 韧性批）：进程重启（升级/崩溃）后 DB 残留 claimed/running——
  // inFlight 内存态已丢、fork worker 随主进程死，执行永无回写，任务卡死在 running（不能重提
  // 不能续跑，此前只能手改 DB）。启动即标 failed「进程重启中断」：failed 可续跑（保留进度）、
  // 编辑重跑或强制重置。走包装后的 tasks——finish 自动生成 task_failed 消息通知到人
  try {
    const orphans = (await tasks.list()).filter((r) => r.status === 'claimed' || r.status === 'running');
    for (const r of orphans) {
      await tasks.finish(
        r.pkg.taskId,
        { status: 'max_turns', reply: '进程重启中断（服务重启时任务在执行中）——可续跑（保留进度）、编辑重跑或强制重置', turns: 0 },
        false,
      );
      await events.append({
        id: `orphan-${r.pkg.taskId}-${randomUUID().slice(0, 8)}`, ts: Date.now(),
        taskId: r.pkg.taskId, employeeId: r.claimedBy ?? 'console', type: 'dispatch',
        summary: `任务 ${r.pkg.taskId} 进程重启中断，标记失败（启动孤儿扫描）`,
      });
    }
    if (orphans.length > 0) {
      log.info('console-api', `孤儿扫描：${orphans.length} 个 claimed/running 任务标 failed「进程重启中断」`);
    }
  } catch (err: unknown) {
    log.error('console-api', '孤儿扫描失败（不阻塞启动）:', errLine(err));
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const query = Object.fromEntries(url.searchParams.entries());

      // 准入闸前置（SSE 长连接同样要过——事件流含命令输出摘要，不容匿名订阅；
      // 限流按新请求计数，长连接本身不占窗口）。remoteAddress 防御式取值：
      // 测试桩 req 无 socket，缺省 unknown 计数（真实连接恒有值）
      const ip = (req as { socket?: { remoteAddress?: string } }).socket?.remoteAddress ?? 'unknown';
      if (guard.rateLimited(ip)) {
        res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '请求过于频繁，请稍后再试' }));
        return;
      }
      const auth = guard.authorize(req.headers, query);
      if (!auth.ok) {
        res.writeHead(auth.status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: auth.error }));
        return;
      }

      // SSE 直播：长连接，不走 JSON handler；客户端断开立即停推
      if ((req.method ?? 'GET') === 'GET' && url.pathname === '/api/events/stream') {
        const sse = createSseHandler(events, { shouldContinue: () => !res.destroyed });
        await sse({ path: url.pathname, query }, res);
        return;
      }

      // 实时推送 SSE（2026-09-10 消息改推送）：counts 角标 + message 新消息；
      // 挂断即退订，客户端 EventSource 自动重连
      if ((req.method ?? 'GET') === 'GET' && url.pathname === '/api/messages/stream') {
        const sse = createLiveSseHandler({
          subscribe: (fn) => {
            liveSubs.add(fn);
            return () => liveSubs.delete(fn);
          },
          counts: liveCounts,
          shouldContinue: () => !res.destroyed,
        });
        await sse({ path: url.pathname, query }, res);
        return;
      }

      // 请求体接收：带上限（超限 413 并断开止损——无上限拼 Buffer 可被单请求 OOM）
      const chunks: Buffer[] = [];
      let received = 0;
      let oversized = false;
      await new Promise<void>((resolve) => {
        req.on('data', (c: Buffer) => {
          chunks.push(c);
          received += c.length;
          if (!oversized && guard.bodyTooLarge(received)) {
            oversized = true;
            res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: `请求体超过上限（${Math.floor(guard.bodyLimitBytes / 1024 / 1024)}MB）` }));
            req.destroy(); // 停止接收余下数据
            resolve();
          }
        });
        req.on('end', resolve);
        req.on('error', resolve); // destroy 后的 close 走 error，不再挂起
      });
      if (oversized) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      const contentType = req.headers['content-type'] ?? '';

      let body: unknown;
      if (raw) {
        if (contentType.includes('json')) {
          // JSON 形状错误是客户端问题：400 而非 500（此前裸 parse 异常落进 catch 500）
          try {
            body = JSON.parse(raw);
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: `请求体不是合法 JSON：${e instanceof Error ? e.message : String(e)}` }));
            return;
          }
        } else {
          // yaml 提交（text/plain 或 yaml）保持原文
          body = raw;
        }
      }

      const out = await handle({
        method: req.method ?? 'GET',
        path: url.pathname,
        query,
        body,
        ...(auth.operator ? { operator: auth.operator } : {}), // 操作者留痕（2026-09-11）
      });
      res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out.json));
    })().catch((e) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  });

  // 安全前置检查（2026-09-11 用户复盘批）：strictMode=true 时未配 auth/bindHost 拒绝启动
  // （fail-safe，生产部署 checklist 的机器可读关）；缺省 false = ERROR 横幅警示不拦启动。
  // 检查在 listen 之前——strict 拒绝启动时端口都不占
  const authOn = guard.authEnabled;
  const hostBound = Boolean(opts.runtime?.bindHost);
  if (opts.runtime?.strictMode === true && (!authOn || !hostBound)) {
    const missing = [!authOn ? 'auth 段（API 鉴权）' : null, !hostBound ? 'bindHost（监听地址收口）' : null]
      .filter(Boolean).join('、');
    throw new Error(`strictMode 已启用但缺少安全配置：${missing}。yaml 补配后再启动（auth.tokens + bindHost，见 examples/console-runtime.example.yaml）`);
  }
  // bindHost（2026-09-11）：缺省不传 = 全网卡现状；生产建议显式收口（127.0.0.1 / 内网段 IP）
  if (hostBound) {
    server.listen(opts.port ?? 0, opts.runtime!.bindHost);
  } else {
    server.listen(opts.port ?? 0);
  }
  if (authOn) {
    log.info('console-api', `API 鉴权已启用：${opts.runtime?.auth?.tokens.length ?? 0} 个具名 token（Authorization: Bearer 或 ?token=）`);
  } else {
    log.error('console-api', '⚠ 安全警示：API 鉴权未启用（yaml 未配 auth 段）——控制台全部接口对可达网段匿名开放（含放行/员工密钥管理）');
    log.error('console-api', '  修复：yaml 配 auth.tokens（token <name> 命令可签发）；生产部署建议同时开 strictMode: true 使缺配拒绝启动');
  }
  if (!hostBound) {
    log.error('console-api', '⚠ 安全警示：未配置 bindHost——监听全网卡（::），任何可达网段主机均可访问；建议收口为 127.0.0.1（配合反代）或内网段具体 IP');
  }
  if (pipeline) {
    pipeline.start();
    (server as ConsoleServer).__runtime = pipeline;
  }
  // 启动即校验一轮（listen 后异步完成不阻塞启动）；此后每日一轮
  integrityMonitor.start();
  (server as ConsoleServer).__driver = driver;
  server.on('close', () => {
    pipeline?.stop();
    integrityMonitor.stop();
    // 驱动资源回收（mysql 连接池 / sqlite 句柄）；测试桩 server 不触发 close，无副作用
    void driver.close().catch((e: unknown) => {
      log.error('store', '驱动关闭失败:', errLine(e));
    });
  });
  return server as ConsoleServer;
}

/**
 * 优雅停机（2026-09-11 P1 治理批）：SIGTERM/SIGINT 时依次——
 * 1. server.close() 停止接受新连接；
 * 2. closeAllConnections() 强制断开存量连接（SSE 长连接永不断开，不主动断则 'close' 事件永不触发，
 *    旧实现裸杀进程时正在写回的响应直接截断）；
 * 3. 'close' 事件联动 pipeline.stop（停 tick/看门狗/清扫定时器）+ 驱动关池；
 * 4. timeoutMs 兜底——个别僵死连接拖住 'close' 时到点直接进收尾，不让进程挂死。
 * 在途任务不强行收割：进程退出后 DB 残留 running 由下次启动孤儿扫描接管（批次2 双保险），
 * 故停机只需要「不再分派新任务 + 干净关池」。
 */
export async function shutdownConsole(server: ConsoleServer, timeoutMs = 30_000): Promise<void> {
  if (server.listening) {
    const closed = new Promise<void>((resolve) => server.once('close', resolve));
    server.close();
    // Node >= 18.2；SSE 长连接必须主动断（等连接自然结束 = 永不结束）
    server.closeAllConnections?.();
    await Promise.race([closed, new Promise((r) => setTimeout(r, timeoutMs))]);
  }
  server.__runtime?.stop(); // 'close' 未触发（僵死连接超时兜底）时幂等直停
  try {
    await server.__driver?.close(); // 'close' 回调里是 fire-and-forget，这里 await 保证池真正归还
  } catch (e: unknown) {
    log.error('store', '驱动关闭失败:', errLine(e));
  }
}

/**
 * CLI 入口的信号接线（2026-09-11）：SIGTERM/SIGINT → 优雅停机 → 进程退出。
 * 不放进 startConsoleServer（每实例装全局信号钩子，测试多 server/ vitest 自身信号会被劫持）。
 */
export function installSignalHandlers(server: ConsoleServer, timeoutMs = 30_000): void {
  const shutdown = (sig: NodeJS.Signals): void => {
    log.info('console-api', `收到 ${sig}，优雅停机…（在途任务由下次启动孤儿扫描接管）`);
    void shutdownConsole(server, timeoutMs).finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
