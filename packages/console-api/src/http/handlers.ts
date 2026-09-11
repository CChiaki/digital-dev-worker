import { parseTaskPackage } from '@ddw/runtime';
import type { AgentEvent, EmployeeOutcome, EmployeeProfile } from '@ddw/runtime';
import { randomUUID } from 'node:crypto';
import type { TaskStore, EventStore } from '../stores/index.js';
import { listPendingChecks, listCheckHistory, type CheckReviewQueue } from '../team/review-gate.js';
import type { CapabilityStore, CapabilityDef } from '../team/capabilities.js';
import { validateCapabilityDef, KNOWN_BUILTIN, KNOWN_MCP_PACKS } from '../team/capabilities.js';
import type { McpServerStatus, McpToolSource } from '../team/mcp-hub.js';
import type { EmployeeStore, EmployeeRecord } from '../team/employee-store.js';
import { validateEmployeeRecord, normalizeEmployeeInput, encryptEmployeeModelKey } from '../team/employee-store.js';
import type { MessageStore } from '../team/messages.js';
import type { PushLogStore } from '../team/push-log.js';
import type { GenerationStore } from '../stores/sql/sql-generation-store.js';
import type { ChannelStore, NotificationChannelDef } from '../team/notifier.js';
import { validateChannelDef, sendTestMessage, encryptChannelSecrets, type YanxunConfig } from '../team/notifier.js';
import type { IntegrityStatus } from '../team/integrity-monitor.js';
import type { SkillStoreLike, SkillRecord, SkillCategory } from '../team/skill-store.js';
import { validateSkillRecord, validateSkillCategory, newSkillId } from '../team/skill-store.js';
import { log, errLine } from '../team/logger.js';

export interface HandlerRequest {
  method: string;
  path: string;
  /** query 参数（值均为字符串） */
  query?: Record<string, string>;
  /** POST body：/api/tasks 为 yaml 原文（string），其余为 JSON 对象 */
  body?: unknown;
  /** 操作者（2026-09-11 API token 鉴权注入）：intervention/config_change 审计留痕「谁操作的」；
   *  鉴权未启用（yaml 无 auth 段）时缺省——历史行为零回归 */
  operator?: string;
}

export interface HandlerResponse {
  status: number;
  json: unknown;
}

export type Handlers = (req: HandlerRequest) => Promise<HandlerResponse>;

const ok = (json: unknown, status = 200): HandlerResponse => ({ status, json });
const err = (status: number, error: string): HandlerResponse => ({ status, json: { error } });

/**
 * 渠道 secret 脱敏回显占位（终审安全修复，对齐员工 model.apiKey 模式）：
 * GET 响应把明文 secret（钉钉加签密钥）/ token（燕讯机器人 access_token）替换为 '***'，缺省则不出现该键；
 * webhookUrl 保留完整（前端已做 host 脱敏展示）。
 */
function redactChannel(def: NotificationChannelDef): NotificationChannelDef {
  return { ...def, ...(def.secret ? { secret: '***' } : {}), ...(def.token ? { token: '***' } : {}) };
}

/**
 * secret/token 占位归一化：前端脱敏回显后提交 '' 或 '***' = 未填写新值（避免占位符字面量入库）。
 * 调用方决定语义：更新时保留原值，新建时视为未填（燕讯 token 必填会再被 validate 拦下）。
 */
function stripSecretPlaceholder(def: NotificationChannelDef): NotificationChannelDef {
  const rest = { ...def };
  let stripped = false;
  if (rest.secret === '' || rest.secret === '***') { delete rest.secret; stripped = true; }
  if (rest.token === '' || rest.token === '***') { delete rest.token; stripped = true; }
  return stripped ? rest : def;
}

/**
 * HTTP handler 层：纯函数 (req) => res，与 node:http 解耦——
 * 测试直接调用（不监听端口），生产由 server.ts 包一层真实 HTTP。
 */
export function createHandlers(deps: {
  tasks: TaskStore;
  events: EventStore;
  employees?: EmployeeProfile[];
  /** 人工复核队列（P10 一体化模式提供）：POST review 唤醒阻塞中的 task_check */
  reviewQueue?: CheckReviewQueue;
  /** 能力注册表（2026-09-05，可选）：任务包 plan 模式 kind → 工具集映射的后台管理 */
  capabilities?: CapabilityStore;
  /** MCP server 连接池（2026-09-06 用户需求 B，可选）：注入后能力 mcp 标识校验纳入
   *  已连接 server 名 + /api/mcp-servers、/api/capabilities/meta 动态清单 */
  mcpHub?: McpToolSource & { statuses(): McpServerStatus[] };
  /** 员工档案存储（2026-09-06 后台化，可选）：注入后 /api/employees 走 CRUD；未注入回退只读 profiles 视图 */
  employeeStore?: EmployeeStore;
  /** AI 解析任务包 provider（server 接线 ModelGateway + 能力注册表；未配置 = 智能生成 400） */
  taskParser?: (description: string) => Promise<{ yaml: string }>;
  /** 消息中心（2026-09-06，可选）：未注入 = /api/messages 返回 400 未启用 */
  messages?: MessageStore;
  /** 推送留痕（2026-09-10 用户需求，可选）：消息 × 渠道推送记录查询；未注入 = /api/push-logs 返回 400 */
  pushLogs?: PushLogStore;
  /** 智能生成记录（2026-09-10 用户需求，可选）：/api/tasks/parse 输入与结果留痕（页面暂不展示） */
  generations?: GenerationStore;
  /** 计数变更通知（2026-09-10 推送改造，可选）：已读/放行/Skill 终审等影响角标的操作后回调——
   *  server 接线向 /api/messages/stream 订阅者重算推送 counts */
  notifyCounts?: () => void;
  /** 通知渠道注册表（2026-09-06，可选；存储企业化 Task 7 起为存储抽象 ChannelStore，File/Sql 双实现）：
   *  未注入 = /api/notification-channels 返回 400 未启用 */
  channels?: ChannelStore;
  /** 审计链完整性监控（2026-09-11 P1 治理批，可选）：GET /api/audit 附带最近校验结果 +
   *  POST /api/audit/verify 立即校验（server 侧启动 + 每日定时）；未注入 = 两处均不出现 */
  integrityMonitor?: { last(): IntegrityStatus | undefined; verifyNow(): Promise<IntegrityStatus> };
  /** 燕讯接入配置（2026-09-10，可选）：runtime yaml yanxun 段解析注入——type=yanxun 渠道
   *  发送测试消息时使用（消息推送侧在 server.ts messageSink 里接） */
  yanxun?: YanxunConfig;
  /** 控制台根地址（可选）：通知直达链接 `${consoleUrl}/tasks/:taskId` */
  consoleUrl?: string;
  /** 发布前仓库可达性校验（2026-09-06 实战修复，可选）：配置 forge 才注入；
   *  repo 占位符/不可达的任务发布时 400 拦截，不带病进调度（test-task-package 教训） */
  repoCheck?: (url: string) => Promise<void>;
  /** 在途执行中性化（2026-09-11 P0 韧性批，可选）：force-reset 对 claimed/running 任务
   *  先调此钩子（server 接线 → scheduler.abandon：迟到回写守卫 + 摘 inFlight + 释放员工） */
  onForceReset?: (taskId: string, claimedBy?: string) => void;
  /** Skill 库（2026-09-06，可选；存储企业化 Task 7 起为存储抽象 SkillStoreLike，File/Sql 双实现）：
   *  分类 + skill 记录 CRUD + 人工终审 */
  skills?: SkillStoreLike;
}): Handlers {
  return async (req) => {
    const { method, path, query = {}, body, operator } = req;
    const seg = path.split('/').filter(Boolean); // ['api', 'tasks', ':id', 'claim']

    /** 配置变更审计留痕（2026-09-11 P0 安全批）：员工/能力/渠道/Skill 等后台写操作写 config_change
     *  事件进审计链（taskId/employeeId 用 'console' 伪标识，payload 带 operator）。
     *  旁路数据：留痕失败只记日志不阻断业务操作（与消息中心同原则） */
    const configChange = async (e: { action: string; target: string }): Promise<void> => {
      try {
        await deps.events.append({
          id: randomUUID(), ts: Date.now(), taskId: 'console', employeeId: 'console',
          type: 'config_change',
          summary: `${e.action}：${e.target}${operator ? `（${operator}）` : ''}`,
          payload: { action: e.action, target: e.target, ...(operator ? { operator } : {}) },
        });
      } catch (err) {
        log.error('audit', 'config_change 留痕失败:', errLine(err));
      }
    };

    try {
      // POST /api/tasks/parse —— AI 解析任务包（2026-09-06）：不落库，返回 yaml 供前端预填确认；
      // 生成记录（2026-09-10）：成功/失败均留痕 ddw_generations（失败记 error，失败也不影响响应）
      if (method === 'POST' && path === '/api/tasks/parse') {
        if (!deps.taskParser) return err(400, '未启用智能生成（未配置模型）');
        const { description } = (body ?? {}) as { description?: string };
        if (typeof description !== 'string' || !description.trim()) return err(400, '缺少 description（自然语言需求描述）');
        try {
          const out = await deps.taskParser(description);
          if (deps.generations) {
            try { await deps.generations.add({ description, yaml: out.yaml }); }
            catch { /* 留痕失败不影响生成响应 */ }
          }
          return ok(out);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (deps.generations) {
            try { await deps.generations.add({ description, error: msg }); }
            catch { /* 留痕失败不影响错误响应 */ }
          }
          return err(400, msg);
        }
      }

      // GET /api/generations —— 智能生成记录（2026-09-10）：最新在前，limit 缺省 100
      if (method === 'GET' && path === '/api/generations') {
        if (!deps.generations) return err(400, '未启用智能生成记录');
        return ok(await deps.generations.list(query.limit !== undefined ? Number(query.limit) || 100 : 100));
      }

      // POST /api/tasks —— 固化任务包（yaml 文本）
      if (method === 'POST' && path === '/api/tasks') {
        if (typeof body !== 'string') return err(400, '请求体应为任务包 yaml 文本');
        let pkg;
        try {
          pkg = parseTaskPackage(body);
        } catch (e) {
          return err(400, e instanceof Error ? e.message : String(e));
        }
        // 任务计划（2026-09-05）：plan 模式逐项校验 kind 已注册且启用（缺省 dev）；
        // 仅对 plan 模式生效，老 tasks 包零回归（不校验）
        if (pkg.plan && deps.capabilities) {
          const defs = await deps.capabilities.list();
          for (const item of pkg.plan) {
            const kind = item.kind ?? 'dev';
            const def = defs.find((c) => c.kind === kind);
            if (!def || !def.enabled) {
              return err(400, `任务项 ${item.id}.kind='${kind}' 未注册或已停用（能力管理中登记后方可使用）`);
            }
          }
        }
        // taskId 查重（2026-09-06 用户反馈；2026-09-08 竞态防护细化）——状态机：
        // draft | pending | claimed | running | done | failed（stores/types.ts）
        // 活跃态（claimed/running，已接单执行中）→ 400 拒绝：覆盖会换掉执行中记录、事件串台；
        // 终态（done/failed）→ 允许覆盖（重跑清残留语义：progress 缺省 = 执行器从零清 workspace/session；
        // 2026-09-10 起重提直接回 pending 进调度，曾发布过的任务无需再点发布）；
        // draft → 允许覆盖（改草稿语义）；pending（未接单、无执行档案）→ 允许覆盖（撤回重发，
        // 覆盖后回 draft 需重新发布；系统无任务删除入口，此为错发任务唯一修正通道）
        const existing = await deps.tasks.get(pkg.taskId);
        if (existing && (existing.status === 'claimed' || existing.status === 'running')) {
          return err(400, `任务 ${pkg.taskId} 正在执行中（状态：${existing.status}），不可重复提交；请等待完成或走断点续跑`);
        }
        // 终态重跑（2026-09-10 用户反馈：failed 重新编辑后不应回到待发布）：
        // failed/done 曾发布过，重提 = 重跑（upsert 清执行态），直接回 pending 进调度，无需再点发布；
        // draft（改稿）/ pending（未接单撤回重发）保持回 draft 需重新发布的既有语义
        const rerun = existing?.status === 'failed' || existing?.status === 'done';
        const rec = await deps.tasks.add(pkg, { draft: !rerun });
        return ok({ taskId: rec.pkg.taskId, status: rec.status }, 201);
      }

      // GET /api/tasks —— 任务池列表（含班组编排视图：role / dependsOn / 依赖就绪状态）
      if (method === 'GET' && path === '/api/tasks') {
        let records = await deps.tasks.list();
        // 员工下钻过滤（2026-09-06）：claimedBy=员工id、status=逗号分隔多值；不传零回归
        if (query.claimedBy) records = records.filter((r) => r.claimedBy === query.claimedBy);
        if (query.status) {
          const wanted = new Set(query.status.split(','));
          records = records.filter((r) => wanted.has(r.status));
        }
        const byId = new Map(records.map((r) => [r.pkg.taskId, r]));
        return ok(records.map(({ pkg, status, claimedBy, claimedAt, createdAt, result, planProgress, failedItemId }) => {
          const deps_ = pkg.dependsOn ?? [];
          const depStates = Object.fromEntries(deps_.map((d) => [d, byId.get(d)?.status ?? 'missing']));
          const blocked = deps_.some((d) => (byId.get(d)?.status ?? 'missing') === 'failed' || !byId.has(d));
          const ready = deps_.length > 0 && deps_.every((d) => byId.get(d)?.status === 'done');
          return {
            taskId: pkg.taskId, title: pkg.title, status, claimedBy, claimedAt,
            // 入池时间（2026-09-11 P1 治理批）：分派序时间序的可见性（列表即 store 时间序）
            createdAt,
            hasResult: result !== undefined,
            reply: result?.reply, // 员工详情历史任务列（2026-09-06）：汇报摘要
            // token 用量（2026-09-11 P2 产品批）：首页面板 Σ 聚合用；无用量任务缺省不出 JSON
            tokenUsage: result?.tokenUsage,
            // 计划模式（2026-09-05）：逐项进度与停点（无 plan 时缺省）
            planProgress,
            failedItemId,
            role: pkg.role,
            // 指定员工（2026-09-06 assignee）：点名分派视图透传，缺省 undefined 不出 JSON
            assignee: pkg.assignee,
            dependsOn: pkg.dependsOn,
            depStates,
            // depsState 仅对 pending 任务展示（ready：依赖全 done；blocked：上游 failed/缺失；
            // waiting：等待上游）；已分派/完成的任务不展示依赖视图
            depsState: status !== 'pending'
              ? undefined
              : blocked ? 'blocked' : ready ? 'ready' : deps_.length > 0 ? 'waiting' : undefined,
          };
        }));
      }

      // /api/tasks/:taskId/...
      if (seg[0] === 'api' && seg[1] === 'tasks' && seg.length >= 3) {
        const taskId = seg[2];

        // POST /api/tasks/:taskId/checks/:item/review —— 人工放行/驳回节点（P10 盯梢闭环）；
        // 不依赖任务池查询（闸门 key 独立，任务在执行中必存在于池，无需 404 前置拦截）；
        // operator（2026-09-11）：API token 操作者名随裁决透传 → intervention 事件留痕「谁放的行」
        if (method === 'POST' && seg[3] === 'checks' && seg[5] === 'review') {
          if (!deps.reviewQueue) return err(400, '未启用人工复核（仅一体化模式 shadow 级提供）');
          const { approved, comment } = (body ?? {}) as { approved?: boolean; comment?: string };
          if (typeof approved !== 'boolean') return err(400, '缺少 approved（boolean）');
          try {
            deps.reviewQueue.review(taskId, seg[4]!, approved, comment, operator);
            deps.notifyCounts?.(); // 放行/驳回改变待审数（2026-09-10 推送角标）
            return ok({ taskId, item: seg[4], approved, ...(comment ? { comment } : {}), ...(operator ? { operator } : {}) });
          } catch (e) {
            return err(404, e instanceof Error ? e.message : String(e));
          }
        }

        // POST /api/tasks/:taskId/checks/:item/void —— 作废失效待审（2026-09-11 P1 治理批）：
        // 任务已终态/进程中断后残留的待审（resolver 随执行消亡，放行/驳回必 404）此前
        // 只能永远挂在历史里。作废 = 写 intervention（voided + operator）进审计链留痕，
        // 推导链（listCheckHistory）视同已裁决清待；仅失效（expired）待审可作废——
        // 执行中任务的待审仍走放行/驳回（作废 resolver 会把执行卡死到看门狗超时）
        if (method === 'POST' && seg[3] === 'checks' && seg[5] === 'void') {
          const item = seg[4]!;
          const recs = await listCheckHistory(deps.events, deps.tasks);
          const rec = recs.find((r) => r.taskId === taskId && r.item === item);
          if (!rec) return err(404, `待审记录不存在: ${taskId} / ${item}`);
          if (!rec.pending) return err(409, `该节点已有裁决（${rec.voided ? '已作废' : rec.approved ? '已放行' : '已驳回'}），无需作废`);
          if (!rec.expired) return err(409, '任务仍在执行中——请用放行/驳回裁决（作废仅针对已失效待审）');
          const { comment } = (body ?? {}) as { comment?: string };
          await deps.events.append({
            id: randomUUID(), ts: Date.now(), taskId, employeeId: 'console',
            type: 'intervention',
            summary: `作废待审节点 ${item}（任务已结束，申报失效）${operator ? `（${operator}）` : ''}`,
            payload: { item, voided: true, ...(comment ? { comment } : {}), ...(operator ? { operator } : {}) },
          });
          deps.notifyCounts?.(); // 作废改变待审口径（expired 本就不计入角标，保持通知一致性）
          return ok({ taskId, item, voided: true });
        }

        const detail = await deps.tasks.get(taskId);
        if (!detail) return err(404, `任务不存在: ${taskId}`);

        if (method === 'GET' && seg.length === 3) return ok(detail);

        // POST /api/tasks/:taskId/resume —— 计划续跑（2026-09-05）：仅 failed 可续（→pending，
        // 保留 progress 清停点）；其他状态 409（前端可再次触发调度）
        if (method === 'POST' && seg[3] === 'resume') {
          try {
            return ok(await deps.tasks.resumePlan(taskId));
          } catch (e) {
            return err(409, e instanceof Error ? e.message : String(e));
          }
        }

        // POST /api/tasks/:taskId/force-reset —— 强制重置（2026-09-11 P0 韧性批）：任意非 draft
        // 状态 → pending 清全部执行态。崩溃恢复死锁兜底：running 既不能重提也不能续跑，此前只能
        // 手改 DB。在途任务先中性化（onForceReset → scheduler.abandon + 释放占用 + 迟到回写守卫），
        // 重置动作留痕 dispatch 事件（带 operator——谁重置的）
        if (method === 'POST' && seg[3] === 'force-reset') {
          try {
            if (detail.status === 'claimed' || detail.status === 'running') {
              deps.onForceReset?.(taskId, detail.claimedBy);
            }
            const rec = await deps.tasks.resetToPending(taskId);
            try {
              await deps.events.append({
                id: `reset-${taskId}-${randomUUID().slice(0, 8)}`, ts: Date.now(),
                taskId, employeeId: detail.claimedBy ?? 'console', type: 'dispatch',
                summary: `任务 ${taskId} 强制重置为 pending${operator ? `（${operator}）` : ''}`,
              });
            } catch { /* 留痕旁路：不阻塞重置本身 */ }
            return ok(rec);
          } catch (e) {
            return err(409, e instanceof Error ? e.message : String(e));
          }
        }

        // POST /api/tasks/:taskId/publish —— 发布（2026-09-06）：仅 draft → pending（发布后才可被接取）
        if (method === 'POST' && seg[3] === 'publish') {
          // 仓库可达性校验（2026-09-06 实战修复）：占位符/不可达仓库发布即拦截（400），不进调度
          if (deps.repoCheck) {
            try {
              await deps.repoCheck(detail.pkg.repo.url);
            } catch (e) {
              return err(400, `发布被拦截：${e instanceof Error ? e.message : String(e)}`);
            }
          }
          try {
            return ok(await deps.tasks.publish(taskId));
          } catch (e) {
            return err(409, e instanceof Error ? e.message : String(e));
          }
        }

        // POST /api/tasks/:taskId/assign —— 指定/取消指定员工（2026-09-06 分派分离）：
        // 仅 draft/pending 可操作（store 层校验，409）；employeeId 缺省/空串 = 取消指定；
        // 非 null 需 employeeStore 中存在且启用（400），点名后下一调度 tick 由 acquireById 生效
        if (method === 'POST' && seg[3] === 'assign') {
          const employeeId = (body as { employeeId?: string } | undefined)?.employeeId?.trim() ?? '';
          if (employeeId) {
            if (!deps.employeeStore) return err(400, '未启用员工档案（需一体化模式）');
            const emp = (await deps.employeeStore.list()).find((e) => e.id === employeeId && e.enabled);
            if (!emp) return err(400, `指定员工不可用（${employeeId}）：不存在或已停用`);
          }
          try {
            return ok(await deps.tasks.assign(taskId, employeeId || null));
          } catch (e) {
            return err(409, e instanceof Error ? e.message : String(e));
          }
        }

        if (method === 'POST' && seg[3] === 'claim') {
          const employeeId = (body as { employeeId?: string } | undefined)?.employeeId;
          if (!employeeId) return err(400, '缺少 employeeId');
          try {
            return ok(await deps.tasks.claim(taskId, employeeId));
          } catch (e) {
            return err(409, e instanceof Error ? e.message : String(e));
          }
        }

        if (method === 'POST' && seg[3] === 'finish') {
          const { outcome, ok: done } = (body ?? {}) as { outcome?: EmployeeOutcome; ok?: boolean };
          if (!outcome) return err(400, '缺少 outcome');
          return ok(await deps.tasks.finish(taskId, outcome, done !== false));
        }
      }

      // GET /api/events —— 直播/查询数据源
      if (method === 'GET' && path === '/api/events') {
        const filter: Parameters<EventStore['list']>[0] = {};
        if (query.taskId) filter.taskId = query.taskId;
        if (query.employeeId) filter.employeeId = query.employeeId;
        if (query.type) filter.type = query.type;
        if (query.since !== undefined) filter.since = Number(query.since);
        return ok(await deps.events.list(filter));
      }

      // Skill 库分类（2026-09-06）：CRUD；删除挂载保护 → 409
      if (seg[0] === 'api' && seg[1] === 'skill-categories') {
        if (!deps.skills) return err(400, '未启用 Skill 库');
        if (method === 'GET' && seg.length === 2) return ok(await deps.skills.listCategories());
        if (method === 'POST' && seg.length === 2) {
          const cat = body as SkillCategory;
          try { validateSkillCategory(cat); } catch (e) { return err(400, e instanceof Error ? e.message : String(e)); }
          // 岗位 name 业务键（2026-09-07）：重名 → 409
          if ((await deps.skills.upsertCategory(cat)) === 'name-conflict') {
            return err(409, `岗位「${cat.name}」已存在（name 唯一）`);
          }
          await configChange({ action: '新增岗位', target: `${cat.id}（${cat.name}）` }); // 2026-09-11 复盘批：留痕补盲区
          return ok({ id: cat.id }, 201);
        }
        if (method === 'DELETE' && seg.length === 3 && seg[2]) {
          const r = await deps.skills.deleteCategory(seg[2]);
          if (r === 'missing') return err(404, `岗位不存在: ${seg[2]}`);
          if (r === 'mounted') return err(409, `岗位 ${seg[2]} 仍有 skill 挂载，先删除或迁移相关 skill`);
          await configChange({ action: '删除岗位', target: seg[2] }); // 2026-09-11 复盘批：留痕补盲区
          return ok({ id: seg[2], removed: true });
        }
      }

      // Skill 库（2026-09-06）：记录 CRUD + 人工终审（status 仅 review 接口可变）
      if (seg[0] === 'api' && seg[1] === 'skills') {
        if (!deps.skills) return err(400, '未启用 Skill 库');
        const store = deps.skills;
        if (method === 'GET' && seg.length === 2) {
          let list = await store.listSkills();
          if (query.status) list = list.filter((s) => s.status === query.status);
          if (query.categoryId) list = list.filter((s) => s.categoryId === query.categoryId);
          if (query.q) {
            const q = query.q.toLowerCase();
            list = list.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
          }
          return ok(list);
        }
        if (method === 'POST' && seg.length === 2) {
          const rec = body as SkillRecord;
          const categoryIds = (await store.listCategories()).map((c) => c.id);
          try { validateSkillRecord(rec, categoryIds); } catch (e) { return err(400, e instanceof Error ? e.message : String(e)); }
          // 客户端自供 id 防覆盖（终审 I3）：已存在 → 409，不得静默覆盖既有记录
          if (rec.id && (await store.getSkill(rec.id))) return err(409, `skill 已存在: ${rec.id}`);
          const full: SkillRecord = {
            ...rec, id: rec.id || newSkillId(), status: 'pending',
            source: rec.source || 'manual', createdAt: Date.now(),
          };
          await store.upsertSkill(full);
          deps.notifyCounts?.(); // 新增即 pending（2026-09-10 推送角标）
          await configChange({ action: '新建 Skill', target: `${full.id}（${full.name}）` }); // 2026-09-11 复盘批：留痕补盲区
          return ok({ id: full.id, status: 'pending' }, 201);
        }
        if (seg.length === 3 && seg[2]) {
          const id = seg[2];
          if (method === 'PUT') {
            const existing = await store.getSkill(id);
            if (!existing) return err(404, `skill 不存在: ${id}`);
            const rec = body as SkillRecord;
            const categoryIds = (await store.listCategories()).map((c) => c.id);
            try { validateSkillRecord({ ...rec, id }, categoryIds); } catch (e) { return err(400, e instanceof Error ? e.message : String(e)); }
            // status/source/createdAt 保留原值（body 不含/被篡改均不生效）；
            // reviewedAt/sourceTaskId 同为服务端事实源，PUT 不得篡改（终审 T2①/M2）
            const merged: SkillRecord = { ...existing, ...rec, id, status: existing.status, source: existing.source, createdAt: existing.createdAt };
            merged.reviewedAt = existing.reviewedAt;
            merged.sourceTaskId = existing.sourceTaskId;
            // type 合并后非 asset：强制清空 assetFiles（终审 T8①，防删空行后旧文件清单残留）
            if (merged.type !== 'asset') merged.assetFiles = undefined;
            await store.upsertSkill(merged);
            await configChange({ action: '修改 Skill', target: `${id}（${merged.name}）` }); // 2026-09-11 复盘批：留痕补盲区
            return ok({ id });
          }
          if (method === 'DELETE') {
            // 留痕要名字（2026-09-11 复盘批）：删前查档拿显示名，查不到回退 id
            const gone = await store.getSkill(id);
            if (!(await store.removeSkill(id))) return err(404, `skill 不存在: ${id}`);
            deps.notifyCounts?.(); // 删待审 skill 影响角标（2026-09-10）
            await configChange({ action: '删除 Skill', target: `${id}${gone ? `（${gone.name}）` : ''}` });
            return ok({ id, removed: true });
          }
        }
        // POST /api/skills/:id/review —— 人工终审（seg.length=4，独立于 :id 段路由）
        if (method === 'POST' && seg.length === 4 && seg[3] === 'review' && seg[2]) {
          const id = seg[2];
          const { action } = (body ?? {}) as { action?: string };
          if (action !== 'approve' && action !== 'reject') return err(400, 'action 必须是 approve | reject');
          const reviewed = await store.reviewSkill(id, action, operator); // 终审人留痕（2026-09-11）
          if (!reviewed) return err(404, `skill 不存在: ${id}`);
          deps.notifyCounts?.(); // 终审改变待审查数（2026-09-10 推送角标）
          await configChange({ action: `Skill 终审 ${action === 'approve' ? '通过' : '驳回'}`, target: `skill ${id}（${reviewed.name}）` });
          return ok({ id, status: reviewed.status });
        }
      }

      // 能力工具来源元数据（2026-09-06 用户需求 A）：前端能力管理下拉的数据源——
      // mcp = 内置包 + 已注册 MCP server 名（yaml 注册即展示，零代码改动）
      if (method === 'GET' && path === '/api/capabilities/meta') {
        return ok({
          builtin: [...KNOWN_BUILTIN],
          mcp: [...KNOWN_MCP_PACKS, ...(deps.mcpHub?.serverNames() ?? [])],
        });
      }

      // MCP server 状态清单（2026-09-06 用户需求 B）：连接状态 + 已发现工具名；
      // 未启用 = 空数组（不是 400——「注册即展示」语义下空注册表是正常态）
      if (method === 'GET' && path === '/api/mcp-servers') {
        return ok(deps.mcpHub?.statuses() ?? []);
      }

      // 能力注册表（2026-09-05）：kind → 工具集映射的后台管理
      if (seg[0] === 'api' && seg[1] === 'capabilities') {
        if (!deps.capabilities) return err(400, '未启用能力注册表');
        // mcp 标识白名单动态化（2026-09-06 用户需求 B）：内置包 + 已注册 MCP server 名
        const allowedMcp = new Set<string>([...KNOWN_MCP_PACKS, ...(deps.mcpHub?.serverNames() ?? [])]);
        if (method === 'GET' && seg.length === 2) return ok(await deps.capabilities.list());
        if (method === 'POST' && seg.length === 2) {
          const def = body as CapabilityDef;
          try { validateCapabilityDef(def, allowedMcp); } catch (e) { return err(400, e instanceof Error ? e.message : String(e)); }
          await deps.capabilities.upsert(def);
          await configChange({ action: '新建能力', target: `${def.kind}（${def.name}）` });
          return ok({ kind: def.kind }, 201);
        }
        if (seg.length === 3) {
          const kind = seg[2]!;
          if (method === 'PUT') {
            const def = body as CapabilityDef;
            try { validateCapabilityDef(def, allowedMcp); } catch (e) { return err(400, e instanceof Error ? e.message : String(e)); }
            if (def.kind !== kind) return err(400, `路径 kind (${kind}) 与 body.kind (${def.kind}) 不一致`);
            await deps.capabilities.upsert(def);
            await configChange({ action: '修改能力', target: `${def.kind}（${def.name}）` });
            return ok({ kind });
          }
          if (method === 'DELETE') {
            const removed = await deps.capabilities.remove(kind);
            if (!removed) return err(404, `能力不存在: ${kind}`);
            await configChange({ action: '删除能力', target: kind });
            return ok({ kind, removed: true });
          }
        }
      }

      // 消息中心（2026-09-06）：列表+未读数 / 单条已读 / 全部已读；
      // 2026-09-10 重设计：type/q/unreadOnly 过滤 + limit/offset 分页（total 为过滤后总数）；
      // 已读类操作回调 notifyCounts → SSE 订阅端重算推送角标
      if (seg[0] === 'api' && seg[1] === 'messages') {
        if (!deps.messages) return err(400, '未启用消息中心');
        if (method === 'GET' && seg.length === 2) {
          const listOpts = {
            ...(query.unreadOnly === '1' ? { unreadOnly: true as const } : {}),
            ...(query.type ? { type: query.type } : {}),
            ...(query.q ? { q: query.q } : {}),
          };
          const [messages, unread] = await Promise.all([deps.messages.list(listOpts), deps.messages.unreadCount()]);
          const offset = query.offset !== undefined ? Math.max(0, Number(query.offset) || 0) : 0;
          const page = query.limit !== undefined
            ? messages.slice(offset, offset + Math.max(1, Number(query.limit) || 1))
            : messages.slice(offset);
          return ok({ messages: page, total: messages.length, unread });
        }
        if (method === 'POST' && seg.length === 4 && seg[3] === 'read') {
          const done = await deps.messages.markRead(seg[2]!);
          if (!done) return err(404, `消息不存在: ${seg[2]}`);
          deps.notifyCounts?.();
          return ok({ id: seg[2], read: true });
        }
        if (method === 'POST' && seg.length === 3 && seg[2] === 'read-all') {
          const marked = await deps.messages.markAllRead();
          deps.notifyCounts?.();
          return ok({ marked });
        }
      }

      // 推送留痕（2026-09-10 用户需求）：消息 × 渠道推送记录（sent/failed + 燕讯 seqNo），
      // taskId 过滤 + limit 条数（缺省 200，最新在前）；未注入 = 400
      if (method === 'GET' && path === '/api/push-logs') {
        if (!deps.pushLogs) return err(400, '未启用推送留痕');
        return ok(await deps.pushLogs.list({
          ...(query.taskId ? { taskId: query.taskId } : {}),
          ...(query.messageId ? { messageId: query.messageId } : {}),
          ...(query.limit !== undefined ? { limit: Number(query.limit) || 200 } : {}),
        }));
      }

      // 通知渠道（2026-09-06）：CRUD + 发送测试消息；
      // 凭据密文化（2026-09-11）：secret/token 入库前 encryptChannelSecrets（DDW_CRED_KEY 在场即加密）
      if (seg[0] === 'api' && seg[1] === 'notification-channels') {
        if (!deps.channels) return err(400, '未启用通知渠道');
        if (method === 'GET' && seg.length === 2) return ok((await deps.channels.list()).map(redactChannel));
        if (method === 'POST' && seg.length === 2) {
          // 新建：secret 留空/'***' = 无 secret（钉钉加签可选），不把占位符入库
          const def = stripSecretPlaceholder(body as NotificationChannelDef);
          try { validateChannelDef(def); } catch (e) { return err(400, e instanceof Error ? e.message : String(e)); }
          await deps.channels.upsert(encryptChannelSecrets(def));
          await configChange({ action: '新建通知渠道', target: `${def.id}（${def.name}）` });
          return ok({ id: def.id }, 201);
        }
        if (seg.length === 4 && seg[3] === 'test') {
          const def = (await deps.channels.list()).find((c) => c.id === seg[2]);
          if (!def) return err(404, `渠道不存在: ${seg[2]}`);
          try {
            const r = await sendTestMessage(def, deps.consoleUrl, deps.yanxun);
            return ok({ id: def.id, sent: true, ...(r.yanxunSeqNo ? { seqNo: r.yanxunSeqNo } : {}) });
          }
          catch (e) { return err(502, e instanceof Error ? e.message : String(e)); }
        }
        if (seg.length === 3 && seg[2]) {
          const id = seg[2];
          if (method === 'PUT') {
            let def = stripSecretPlaceholder(body as NotificationChannelDef);
            // secret/token 回写保护（终审安全修复）：留空/'***' = 保持原值（渠道已存在时）——
            // 回填先于校验：燕讯 token 必填，不能因脱敏占位被清空后拦 400；
            // 回填值可能是库里既有密文（enc:v1:），encryptChannelSecrets 幂等跳过不二次加密
            const existing = (await deps.channels.list()).find((c) => c.id === id);
            if (def.secret === undefined && existing?.secret) def = { ...def, secret: existing.secret };
            if (def.token === undefined && existing?.token) def = { ...def, token: existing.token };
            try { validateChannelDef(def); } catch (e) { return err(400, e instanceof Error ? e.message : String(e)); }
            if (def.id !== id) return err(400, `路径 id (${id}) 与 body.id (${def.id}) 不一致`);
            await deps.channels.upsert(encryptChannelSecrets(def));
            await configChange({ action: '修改通知渠道', target: `${def.id}（${def.name}）` });
            return ok({ id });
          }
          if (method === 'DELETE') {
            const removed = await deps.channels.remove(id);
            if (!removed) return err(404, `渠道不存在: ${id}`);
            await configChange({ action: '删除通知渠道', target: id });
            return ok({ id, removed: true });
          }
        }
      }

      // GET /api/checks —— 待审节点列表（事件流推导，重启安全；P10 人工盯梢闭环）；
      // 按任务存活过滤（2026-09-10 用户反馈角标数值不对）：执行结束任务的残留待审不再出现
      if (method === 'GET' && path === '/api/checks') {
        return ok(await listPendingChecks(deps.events, deps.tasks));
      }

      // GET /api/checks/history —— 放行全量记录（2026-09-10 用户需求：人工放行页默认待办、
      // 过滤看全部）：待审 + 已裁决（approved/comment/裁决时间）+ 已失效（任务结束仍无裁决的
      // 幽灵待审）；checkTs 倒序（最新在前）
      if (method === 'GET' && path === '/api/checks/history') {
        return ok((await listCheckHistory(deps.events, deps.tasks)).sort((a, b) => b.checkTs - a.checkTs));
      }

      // 数字员工（2026-09-06 后台化）：GET 列表（store 优先，回退只读 profiles）+ CRUD（删除=停用）
      if (seg[0] === 'api' && seg[1] === 'employees') {
        if (!deps.employeeStore) {
          if (method !== 'GET') return err(400, '未启用员工档案管理（未配置员工存储）');
          // 现有 GET profiles 只读视图（回退路径，零回归）；skills 已随多岗位改造退役不再下发（2026-09-08）
          const profiles = deps.employees ?? [];
          const records = await deps.tasks.list();
          const running = new Map<string, string[]>(); // employeeId → 执行中 taskId 列表
          for (const r of records) {
            if (r.status !== 'claimed' && r.status !== 'running') continue;
            if (!r.claimedBy) continue;
            const list = running.get(r.claimedBy) ?? [];
            list.push(r.pkg.taskId);
            running.set(r.claimedBy, list);
          }
          return ok(profiles.map((p) => ({
            id: p.id,
            name: p.name,
            roles: [p.role],
            supervision: p.supervision?.level ?? 'shadow',
            busy: (running.get(p.id)?.length ?? 0) > 0,
            runningTasks: running.get(p.id) ?? [],
          })));
        } else {
          const store = deps.employeeStore;
          if (method === 'GET' && seg.length === 2) {
            const records = await store.list();
            const running = new Map<string, string[]>(); // employeeId → 执行中 taskId 列表
            const taskRecords = await deps.tasks.list();
            for (const r of taskRecords) {
              if (r.status !== 'claimed' && r.status !== 'running') continue;
              if (!r.claimedBy) continue;
              const list = running.get(r.claimedBy) ?? [];
              list.push(r.pkg.taskId);
              running.set(r.claimedBy, list);
            }
            // model.apiKey 脱敏（GET 不回显明文 key）
            // 多岗位视图（2026-09-07）：roles 数组下发；skills / skillCategories 已退役，不再下发
            return ok(records.map((r) => ({
              id: r.id, name: r.name, roles: r.roles,
              capabilities: r.capabilities, enabled: r.enabled,
              supervision: r.supervision?.level ?? 'shadow',
              ...(r.model ? { model: { ...r.model, apiKey: '***' } } : {}),
              busy: (running.get(r.id)?.length ?? 0) > 0,
              runningTasks: running.get(r.id) ?? [],
            })));
          }
          if (method === 'POST' && seg.length === 2) {
            // supervision 归一化（终审修复）：前端提交扁平字符串（'shadow' 等），归一为 { level } 对象
            const rec = normalizeEmployeeInput(body as EmployeeRecord);
            const kinds = deps.capabilities ? (await deps.capabilities.list()).map((c) => c.kind) : [];
            // 岗位名白名单（2026-09-07）：分类 name 即岗位
            const roleNames = deps.skills ? (await deps.skills.listCategories()).map((c) => c.name) : [];
            try { validateEmployeeRecord(rec, kinds, roleNames); } catch (e) { return err(400, e instanceof Error ? e.message : String(e)); }
            if (await store.get(rec.id)) return err(409, `员工 id 已存在: ${rec.id}`);
            // apiKey 密文落库（2026-09-11 复盘批）：明文 key 入库前 enc:v1 加密（幂等，主密钥缺省时原样）
            await store.upsert(encryptEmployeeModelKey({ ...rec, createdAt: Date.now() }));
            await configChange({ action: '新建数字员工', target: `${rec.id}（${rec.name}）` });
            return ok({ id: rec.id }, 201);
          }
          if (seg.length === 3 && seg[2]) {
            const id = seg[2];
            if (method === 'PUT') {
              // supervision 归一化同 POST；createdAt 保留原值（前端 GET 不回显该字段，整行提交会丢）
              const rec = normalizeEmployeeInput(body as EmployeeRecord);
              if (rec.id !== id) return err(400, `路径 id (${id}) 与 body.id (${rec.id}) 不一致`);
              const existing = await store.get(id);
              if (!existing) return err(404, `员工不存在: ${id}`);
              // apiKey 回写保护（2026-09-06 增补）：前端脱敏回显后提交 '***' 或留空 = 保持原 key；
              // 未提及的字段（如 api）保留原绑定值
              if (rec.model && (rec.model.apiKey === '' || rec.model.apiKey === '***')) {
                if (!existing.model) return err(400, '新绑定模型的 apiKey 不能为空');
                rec.model = { ...existing.model, ...rec.model, apiKey: existing.model.apiKey };
              }
              const kinds = deps.capabilities ? (await deps.capabilities.list()).map((c) => c.kind) : [];
              // 岗位名白名单（2026-09-07）：分类 name 即岗位（与 POST 同口径）
              const roleNames = deps.skills ? (await deps.skills.listCategories()).map((c) => c.name) : [];
              try { validateEmployeeRecord(rec, kinds, roleNames); } catch (e) { return err(400, e instanceof Error ? e.message : String(e)); }
              // createdAt 保留原值（body 不含该字段——GET 不回显，整行替换会丢失创建时间）；
              // apiKey 密文落库（2026-09-11 复盘批）：新提交明文 key 加密，回写保留的原 key 已是密文（幂等跳过）
              await store.upsert(encryptEmployeeModelKey({ ...rec, createdAt: existing.createdAt }));
              await configChange({ action: '修改数字员工', target: `${rec.id}（${rec.name}）` });
              return ok({ id });
            }
            if (method === 'DELETE') {
              const disabled = await store.setEnabled(id, false);
              if (!disabled) return err(404, `员工不存在: ${id}`);
              await configChange({ action: '停用数字员工', target: id });
              return ok({ id, enabled: false });  // 停用而非物理删除：历史任务 claimedBy 引用不断
            }
          }
        }
      }

      // GET /api/audit —— 审计台账 v1：全事件倒序 + 按类型计数；integrity=1 附 hash 链校验
      // 分批加载（2026-09-10 用户需求）：type 过滤 + limit/offset 分页——事件量大时全量 JSON 传输
      // 拖慢首屏，前端按 200 条/批拉取；byType 计数始终基于全量（类型筛选计数不受分页影响）
      // lastIntegrity（2026-09-11 P1 治理批）：驻内存的最近一次定时/手动校验结果零成本附带
      // （integrity=1 则即时全链重算，语义不同：一个是「最近校验状态」一个是「现在就校验」）
      if (method === 'GET' && path === '/api/audit') {
        const events = await deps.events.list();
        const byType: Record<string, number> = {};
        for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
        const filtered = query.type ? events.filter((e) => e.type === query.type) : events;
        const desc = [...filtered].reverse();
        const offset = query.offset !== undefined ? Math.max(0, Number(query.offset) || 0) : 0;
        const sliced = query.limit !== undefined
          ? desc.slice(offset, offset + Math.max(1, Number(query.limit) || 1))
          : desc.slice(offset);
        const integrity = query.integrity !== undefined && deps.events.verifyIntegrity
          ? await deps.events.verifyIntegrity()
          : undefined;
        const lastIntegrity = deps.integrityMonitor?.last();
        return ok({
          total: filtered.length, byType, events: sliced,
          ...(integrity ? { integrity } : {}),
          ...(lastIntegrity ? { lastIntegrity } : {}),
        });
      }

      // POST /api/audit/verify —— 立即校验审计链完整性（2026-09-11 P1 治理批「立即校验」按钮）：
      // 即时全链重算并更新驻内存最近结果（GET /api/audit 之后附带新值）
      if (method === 'POST' && path === '/api/audit/verify') {
        if (!deps.integrityMonitor) return err(400, '完整性校验未启用');
        try {
          return ok(await deps.integrityMonitor.verifyNow());
        } catch (e) {
          return err(500, e instanceof Error ? e.message : String(e));
        }
      }

      // GET /api/audit/:taskId —— 审计台账 v2：任务级全链路聚合（状态+时间线+工具统计）
      if (method === 'GET' && seg[0] === 'api' && seg[1] === 'audit' && seg.length === 3) {
        const taskId = seg[2];
        const task = await deps.tasks.get(taskId);
        if (!task) return err(404, `任务不存在: ${taskId}`);
        const timeline = await deps.events.list({ taskId });
        const byName = new Map<string, { name: string; count: number; errors: number }>();
        for (const e of timeline) {
          if (e.type !== 'tool_call') continue;
          const rec = byName.get(e.summary) ?? { name: e.summary, count: 0, errors: 0 };
          rec.count++;
          if ((e.payload as { isError?: boolean } | undefined)?.isError === true) rec.errors++;
          byName.set(e.summary, rec);
        }
        return ok({
          task,
          timeline,
          toolCalls: [...byName.values()],
          reply: task.result?.reply,
        });
      }

      return err(404, `未知路由: ${method} ${path}`);
    } catch (e) {
      // 任务包解析失败 → 400（其余异常统一 500）
      const msg = e instanceof Error ? e.message : String(e);
      return err(500, msg);
    }
  };
}
