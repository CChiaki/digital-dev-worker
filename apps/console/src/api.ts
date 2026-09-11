import type { AgentEvent, EmployeeOutcome, TaskPackage } from '@ddw/runtime';

/** 任务计划进度留痕（计划执行器逐项回写，2026-09-05）：failedItemId 指向停点项 */
export interface PlanProgress { itemId: string; kind: string; title: string; status: 'done' | 'failed' | 'skipped'; }

export interface TaskSummary {
  taskId: string;
  title: string;
  status: 'draft' | 'pending' | 'claimed' | 'running' | 'done' | 'failed';
  claimedBy?: string;
  claimedAt?: number;
  /** 入池时间（2026-09-11 P1 治理批）：列表即分派序（时间序），旧库迁移行以 updated_at 近似 */
  createdAt?: number;
  hasResult: boolean;
  /** 班组编排视图（P8）：岗位要求 / 包级依赖 / 依赖就绪状态 */
  role?: string;
  /** 指定员工（2026-09-06 assignee）：点名分派，缺省 undefined 不出 JSON */
  assignee?: string;
  dependsOn?: string[];
  depStates?: Record<string, string>;
  depsState?: 'ready' | 'waiting' | 'blocked';
  /** 计划模式（2026-09-05）：逐项进度与停点（无 plan 时缺省） */
  planProgress?: PlanProgress[];
  failedItemId?: string;
  /** 汇报摘要（2026-09-06 员工详情历史任务列）：result.reply 透传，无结果时缺省 */
  reply?: string;
  /** token 用量（2026-09-11 P2 产品批）：result.tokenUsage 透传，首页面板 Σ 聚合 */
  tokenUsage?: { input: number; output: number; calls: number };
}

/** 能力定义（任务项 kind → 工具集映射；后台可配置，2026-09-05） */
export interface CapabilityDef {
  kind: string;
  name: string;
  description?: string;
  tools: { builtin: string[]; mcp: string[] };
  enabled: boolean;
}

export interface TaskDetailRecord {
  pkg: TaskPackage;
  status: TaskSummary['status'];
  claimedBy?: string;
  claimedAt?: number;
  result?: EmployeeOutcome;
  /** 计划模式（2026-09-05）：逐项进度与停点（无 plan 时缺省） */
  planProgress?: PlanProgress[];
  failedItemId?: string;
}

export interface AuditResult {
  total: number;
  byType: Record<string, number>;
  events: AgentEvent[];
  /** ?integrity=1 即时全链重算报告（服务端附带） */
  integrity?: { ok: boolean; total: number; brokenAt?: string };
  /** 最近一次定时/手动校验结果（2026-09-11 P1 治理批）：零成本驻内存值，台账页徽标数据源 */
  lastIntegrity?: { ok: boolean; at: number; total: number; brokenAt?: string };
}

/** MCP server 状态（2026-09-06 用户需求 B）：yaml mcpServers 注册 → 服务端连接发现的结果视图 */
export interface McpServerStatus {
  name: string;
  status: 'connected' | 'error';
  error?: string;
  tools: string[];
}

/** 审计台账 v2 任务级聚合（GET /api/audit/:taskId） */
export interface TaskAudit {
  task: TaskDetailRecord;
  timeline: AgentEvent[];
  toolCalls: { name: string; count: number; errors: number }[];
  reply?: string;
}

/** 数字员工名册条目（P9-T3 只读视图）：忙闲由任务池 claimed/running 推导 */
export interface EmployeeSummary {
  id: string;
  name: string;
  /** 多岗位（2026-09-07 员工多岗位 T5 评审对齐）：与 EmployeeRecordView.roles 同语义，元素为岗位（分类）名 */
  roles: string[];
  /** 【退役 2026-09-07】调度改按岗位精确匹配；旧数据可能有值（2026-09-07 复查：前端已无 .skills 消费点，改可选） */
  skills?: string[];
  supervision: 'shadow' | 'assisted' | 'trusted';
  busy: boolean;
  runningTasks: string[];
}

/** 数字员工档案视图（2026-09-06 后台化 CRUD）：busy/runningTasks 由任务池 claimed/running 推导 */
export interface EmployeeRecordView {
  id: string;
  name: string;
  /** 多岗位（2026-09-07）：员工可兼多岗，元素为岗位（分类）名；替代退役的单值 role */
  roles: string[];
  /** 【退役 2026-09-07】调度改按岗位精确匹配；旧数据可能有值，前端不再提交 */
  skills?: string[];
  /** 能力 kind 绑定：任务项 kind ∈ 此集合才可执行；空数组 = 全部可用 */
  capabilities: string[];
  /** false = 停用（调度不分派；历史任务保留） */
  enabled: boolean;
  /** 员工专属模型绑定（一人一模型一 key）；GET 脱敏后 apiKey='***'，PUT 留空/'***' 保原 key */
  model?: { baseUrl: string; apiKey: string; model: string; api?: 'openai-completions' | 'anthropic-messages' };
  supervision: 'shadow' | 'assisted' | 'trusted';
  busy: boolean;
  runningTasks: string[];
}

/** 待审节点（P10 人工盯梢）：task_check 申报后等待人工放行/驳回 */
export interface PendingCheck {
  taskId: string;
  item: string;
  result: string;
}

/** 放行记录（2026-09-10 用户需求）：待审 + 已裁决 + 已失效（任务结束仍无裁决的幽灵待审） */
export interface CheckRecordView extends PendingCheck {
  /** run_cmd 白名单外命令放行：true 时 result 为命令行 */
  bash?: boolean;
  /** 申报时间 */
  checkTs: number;
  pending: boolean;
  approved?: boolean;
  /** 作废裁决（2026-09-11 P1 治理批）：仅失效（任务已结束）待审可作废，写 intervention 留痕清待 */
  voided?: boolean;
  comment?: string;
  /** 裁决人（2026-09-11 API token 操作者名；服务端未启用鉴权/历史数据缺省） */
  operator?: string;
  verdictTs?: number;
  expired?: boolean;
}

/** 消息中心条目（Task 10 前端）：类型/标题/摘要/直达任务，readAt 为空 = 未读 */
export interface MessageView {
  id: string; type: 'review_required' | 'task_failed' | 'task_done' | 'skill_pending';
  title: string; summary: string; taskId: string; employeeId?: string;
  createdAt: number; readAt?: number;
}

/** 推送留痕条目（2026-09-10）：一条消息 × 一个渠道的推送结果 */
export interface PushLogView {
  id: string;
  messageId: string;
  taskId: string;
  messageTitle: string;
  channelId: string;
  channelType: string;
  channelName: string;
  status: 'sent' | 'failed';
  error?: string;
  yanxunSeqNo?: string;
  createdAt: number;
}

/** 通知渠道定义（Task 10 前端，对齐后端 NotificationChannelDef）：dingtalk 加签 secret 可选；
 *  yanxun 配机器人 access_token（token），不走 webhookUrl */
export interface NotificationChannelView {
  id: string;
  type: 'dingtalk' | 'wecom' | 'webhook' | 'yanxun';
  name: string;
  webhookUrl: string;
  secret?: string;
  token?: string;
  enabled: boolean;
}

/** Skill 类型：knowledge 知识 / constraint 约束 / asset 可执行资产（2026-09-06 Skill 库） */
export type SkillType = 'knowledge' | 'constraint' | 'asset';

export interface SkillRecordView {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  type: SkillType;
  content: string;
  assetFiles?: { path: string; content: string }[];
  status: 'pending' | 'approved' | 'rejected';
  source: string;
  sourceTaskId?: string;
  createdAt: number;
  reviewedAt?: number;
}

export interface SkillCategoryView { id: string; name: string; description?: string; }

export interface EventQuery {
  taskId?: string;
  employeeId?: string;
  type?: string;
  since?: number;
}

export type EventFilterType = 'all' | AgentEvent['type'];

/** 当前操作者（v1 简化：控制台操作人即数字员工身份，localStorage 可改） */
export function claimId(): string {
  try {
    return localStorage.getItem('ddw-employee-id') ?? 'emp-01';
  } catch {
    return 'emp-01';
  }
}

/** API 访问令牌（2026-09-11 服务端 auth 鉴权）：localStorage 持有，服务端未启用鉴权时不发送；
 *  401 时 window 广播 'ddw:unauthorized'（App.vue 弹 TokenGate 录入，保存后整页刷新重放） */
export function apiToken(): string | null {
  try {
    return localStorage.getItem('ddw-token');
  } catch {
    return null;
  }
}

async function request<T>(method: string, url: string, body?: unknown, raw = false): Promise<T> {
  const token = apiToken();
  const headers: Record<string, string> = {
    ...(raw ? { 'content-type': 'text/plain; charset=utf-8' } : {}),
    ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const init: RequestInit = {
    method,
    headers,
    ...(body !== undefined ? { body: raw ? String(body) : JSON.stringify(body) } : {}),
  };
  const res = await fetch(url, init);
  if (res.status === 401) {
    // 触发 TokenGate（token 缺失/失效/服务端刚启用鉴权）；仍按原逻辑抛错给调用方展示
    window.dispatchEvent(new CustomEvent('ddw:unauthorized'));
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export const api = {
  listTasks(): Promise<TaskSummary[]> {
    return request('GET', '/api/tasks');
  },
  getTask(taskId: string): Promise<TaskDetailRecord> {
    return request('GET', `/api/tasks/${taskId}`);
  },
  createTask(yaml: string): Promise<{ taskId: string; status: string }> {
    return request('POST', '/api/tasks', yaml, true);
  },
  // 智能生成（终审 G1，2026-09-06）：自然语言描述 → AI 解析为任务包 yaml（不落库，前端预填确认）
  parseTask(description: string): Promise<{ yaml: string }> {
    return request('POST', '/api/tasks/parse', { description });
  },
  claimTask(taskId: string, employeeId: string): Promise<TaskDetailRecord> {
    return request('POST', `/api/tasks/${taskId}/claim`, { employeeId });
  },
  finishTask(taskId: string, outcome: EmployeeOutcome, ok: boolean): Promise<TaskDetailRecord> {
    return request('POST', `/api/tasks/${taskId}/finish`, { outcome, ok });
  },
  listEvents(query: EventQuery = {}): Promise<AgentEvent[]> {
    const qs = new URLSearchParams();
    if (query.taskId) qs.set('taskId', query.taskId);
    if (query.employeeId) qs.set('employeeId', query.employeeId);
    if (query.type) qs.set('type', query.type);
    if (query.since !== undefined) qs.set('since', String(query.since));
    const s = qs.toString();
    return request('GET', `/api/events${s ? `?${s}` : ''}`);
  },
  audit(query: { type?: string; limit?: number; offset?: number } = {}): Promise<AuditResult> {
    const qs = new URLSearchParams();
    if (query.type) qs.set('type', query.type);
    if (query.limit !== undefined) qs.set('limit', String(query.limit));
    if (query.offset !== undefined) qs.set('offset', String(query.offset));
    const s = qs.toString();
    return request('GET', `/api/audit${s ? `?${s}` : ''}`);
  },
  auditTask(taskId: string): Promise<TaskAudit> {
    return request('GET', `/api/audit/${taskId}`);
  },
  // 立即校验审计链完整性（2026-09-11 P1 治理批）：即时全链重算并更新服务端驻内存最近结果
  verifyAudit(): Promise<{ ok: boolean; at: number; total: number; brokenAt?: string }> {
    return request('POST', '/api/audit/verify', {});
  },
  listEmployees(): Promise<EmployeeRecordView[]> {
    return request('GET', '/api/employees');
  },
  // 员工档案 CRUD（2026-09-06 后台化）：删除 = 停用（DELETE → enabled=false）
  createEmployee(rec: Omit<EmployeeRecordView, 'busy' | 'runningTasks'>): Promise<{ id: string }> {
    return request('POST', '/api/employees', rec);
  },
  updateEmployee(id: string, rec: Omit<EmployeeRecordView, 'busy' | 'runningTasks'>): Promise<{ id: string }> {
    return request('PUT', `/api/employees/${id}`, rec);
  },
  disableEmployee(id: string): Promise<{ id: string; enabled: boolean }> {
    return request('DELETE', `/api/employees/${id}`);
  },
  // 任务过滤查询（2026-09-06 员工下钻）：claimedBy=员工id、status=逗号分隔多值（如 'claimed,running'）
  listTasksFiltered(query: { claimedBy?: string; status?: string }): Promise<TaskSummary[]> {
    const qs = new URLSearchParams();
    if (query.claimedBy) qs.set('claimedBy', query.claimedBy);
    if (query.status) qs.set('status', query.status);
    const s = qs.toString();
    return request('GET', `/api/tasks${s ? `?${s}` : ''}`);
  },
  listChecks(): Promise<PendingCheck[]> {
    return request('GET', '/api/checks');
  },
  // 放行全量记录（2026-09-10）：待审 + 已裁决 + 已失效，checkTs 倒序
  listCheckHistory(): Promise<CheckRecordView[]> {
    return request('GET', '/api/checks/history');
  },
  reviewCheck(taskId: string, item: string, approved: boolean, comment?: string): Promise<{ taskId: string; item: string; approved: boolean }> {
    return request('POST', `/api/tasks/${taskId}/checks/${item}/review`, comment ? { approved, comment } : { approved });
  },
  // 作废失效待审（2026-09-11 P1 治理批）：任务已结束的残留待审写 intervention（voided）留痕清待；
  // 执行中任务的待审仍走 reviewCheck（409 由服务端裁决）
  voidCheck(taskId: string, item: string, comment?: string): Promise<{ taskId: string; item: string; voided: boolean }> {
    return request('POST', `/api/tasks/${taskId}/checks/${item}/void`, comment ? { comment } : {});
  },
  // 能力注册表（2026-09-05）：kind → 工具集映射的后台管理
  listCapabilities(): Promise<CapabilityDef[]> {
    return request('GET', '/api/capabilities');
  },
  /** 能力工具来源元数据（2026-09-06 用户需求 A）：builtin/mcp 下拉选项由服务端下发 */
  capabilityMeta(): Promise<{ builtin: string[]; mcp: string[] }> {
    return request('GET', '/api/capabilities/meta');
  },
  /** MCP server 状态清单（2026-09-06 用户需求 B）：yaml 注册即展示（连接状态 + 已发现工具） */
  listMcpServers(): Promise<McpServerStatus[]> {
    return request('GET', '/api/mcp-servers');
  },
  createCapability(def: CapabilityDef): Promise<{ kind: string }> {
    return request('POST', '/api/capabilities', def);
  },
  updateCapability(kind: string, def: CapabilityDef): Promise<{ kind: string }> {
    return request('PUT', `/api/capabilities/${kind}`, def);
  },
  deleteCapability(kind: string): Promise<{ kind: string }> {
    return request('DELETE', `/api/capabilities/${kind}`);
  },
  // 草稿任务发布（Task 7）：draft → pending 进入调度；仅 draft 可发布（其他状态 409）
  publishTask(taskId: string): Promise<TaskDetailRecord> {
    return request('POST', `/api/tasks/${taskId}/publish`, {});
  },
  // 计划续跑（2026-09-05）：仅 failed 可续（其他状态 409），成功后 status 回 pending；返回完整任务记录（对齐后端 resumePlan）
  resumeTask(taskId: string): Promise<TaskDetailRecord> {
    return request('POST', `/api/tasks/${taskId}/resume`, {});
  },
  // 强制重置（2026-09-11 P0 韧性批）：非 draft 任意状态 → pending 清全部执行态；
  // 崩溃恢复死锁兜底（running 不能重提不能续跑）；后端先中性化在途执行再重置
  forceResetTask(taskId: string): Promise<TaskDetailRecord> {
    return request('POST', `/api/tasks/${taskId}/force-reset`, {});
  },
  // 指定/取消指定员工（2026-09-06 分派分离）：仅 draft/pending 可操作（其他状态 409）；
  // employeeId null = 取消指定（body 空对象，后端把缺省/空串都当取消）
  assignTask(taskId: string, employeeId: string | null): Promise<TaskDetailRecord> {
    return request('POST', `/api/tasks/${taskId}/assign`, employeeId ? { employeeId } : {});
  },
  // 消息中心（Task 10；2026-09-10 重设计加过滤/分页）：type/q/unreadOnly 过滤 + limit/offset 分页；
  // unread 为未读总数（角标），total 为过滤后总数（分页用）
  listMessages(
    query: { type?: string; q?: string; unreadOnly?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{ messages: MessageView[]; total: number; unread: number }> {
    const qs = new URLSearchParams();
    if (query.type) qs.set('type', query.type);
    if (query.q) qs.set('q', query.q);
    if (query.unreadOnly) qs.set('unreadOnly', '1');
    if (query.limit !== undefined) qs.set('limit', String(query.limit));
    if (query.offset !== undefined) qs.set('offset', String(query.offset));
    const s = qs.toString();
    return request('GET', `/api/messages${s ? `?${s}` : ''}`);
  },
  markMessageRead(id: string): Promise<{ id: string; read: boolean }> {
    return request('POST', `/api/messages/${id}/read`, {});
  },
  markAllMessagesRead(): Promise<{ marked: number }> {
    return request('POST', `/api/messages/read-all`, {});
  },
  // 推送留痕（2026-09-10 用户需求）：消息 × 渠道推送记录，最新在前
  listPushLogs(query: { taskId?: string; messageId?: string; limit?: number } = {}): Promise<PushLogView[]> {
    const qs = new URLSearchParams();
    if (query.taskId) qs.set('taskId', query.taskId);
    if (query.messageId) qs.set('messageId', query.messageId);
    if (query.limit !== undefined) qs.set('limit', String(query.limit));
    const s = qs.toString();
    return request('GET', `/api/push-logs${s ? `?${s}` : ''}`);
  },
  // 通知渠道（Task 10）：CRUD + 发送测试消息（后端不可达 502 原样 error 上抛）
  listChannels(): Promise<NotificationChannelView[]> { return request('GET', '/api/notification-channels'); },
  createChannel(def: NotificationChannelView): Promise<{ id: string }> { return request('POST', '/api/notification-channels', def); },
  updateChannel(id: string, def: NotificationChannelView): Promise<{ id: string }> { return request('PUT', `/api/notification-channels/${id}`, def); },
  deleteChannel(id: string): Promise<{ id: string }> { return request('DELETE', `/api/notification-channels/${id}`); },
  testChannel(id: string): Promise<{ id: string; sent: boolean }> { return request('POST', `/api/notification-channels/${id}/test`, {}); },
  // Skill 库（2026-09-06）：分类 + skill CRUD + 人工终审
  listSkills(query: { status?: string; categoryId?: string; q?: string } = {}): Promise<SkillRecordView[]> {
    const qs = new URLSearchParams();
    if (query.status) qs.set('status', query.status);
    if (query.categoryId) qs.set('categoryId', query.categoryId);
    if (query.q) qs.set('q', query.q);
    const s = qs.toString();
    return request('GET', `/api/skills${s ? `?${s}` : ''}`);
  },
  // source 省略：后端缺省 'manual'（skill-store POST 分支 rec.source || 'manual'）
  createSkill(rec: Omit<SkillRecordView, 'id' | 'status' | 'source' | 'createdAt' | 'reviewedAt'>): Promise<{ id: string; status: string }> {
    return request('POST', '/api/skills', rec);
  },
  updateSkill(id: string, rec: Partial<SkillRecordView>): Promise<{ id: string }> {
    return request('PUT', `/api/skills/${id}`, rec);
  },
  deleteSkill(id: string): Promise<{ id: string; removed: boolean }> {
    return request('DELETE', `/api/skills/${id}`);
  },
  reviewSkill(id: string, action: 'approve' | 'reject'): Promise<{ id: string; status: string }> {
    return request('POST', `/api/skills/${id}/review`, { action });
  },
  listSkillCategories(): Promise<SkillCategoryView[]> {
    return request('GET', '/api/skill-categories');
  },
  createSkillCategory(cat: SkillCategoryView): Promise<{ id: string }> {
    return request('POST', '/api/skill-categories', cat);
  },
  deleteSkillCategory(id: string): Promise<{ id: string; removed: boolean }> {
    return request('DELETE', `/api/skill-categories/${id}`);
  },
};
