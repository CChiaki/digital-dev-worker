export type CallType = 'chat' | 'code' | 'review' | 'test';

/** 盯梢放权等级（spec 4.4 放权配置化）：shadow 盯梢期 / assisted 辅助 / trusted 信任 */
export type SupervisionLevel = 'shadow' | 'assisted' | 'trusted';

export interface SupervisionPolicy {
  level: SupervisionLevel;
  /** 【退役 2026-09-11】trusted 原设计为按员工扩展 bash 白名单（extraCommands），用户改为
   *  信任期白名单外直接执行（ControlledBash bypassWhitelist）——字段保留兼容旧档读入，已不消费 */
  extraCommands?: string[];
}

/** 模型端点协议（缺省 openai-completions；anthropic-messages 走 Anthropic Messages API） */
export type ModelApi = 'openai-completions' | 'anthropic-messages';

export interface ModelSpec {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  api?: ModelApi;
}

export interface RouteConfig {
  callType: CallType;
  primary: ModelSpec;
  fallback?: ModelSpec;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type ToolParamSpec = Record<
  string,
  { type: string; description: string; required?: boolean }
>;

export interface ToolSchema {
  name: string;
  description: string;
  parameters: ToolParamSpec;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParamSpec;
  /** 适配器实现类型标注（spec 7.3）：api=系统 API 直连；ui=Playwright 垫片（浏览器原子动作）。
   *  同一工具契约可双实现互换（有 API 走 api，无 API"钉子户"走 ui 兜底），缺省视为 api。 */
  impl?: 'api' | 'ui';
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export type AgentEventType =
  | 'thinking'
  | 'tool_call'
  | 'diff'
  | 'report'
  | 'intervention'
  | 'error'
  | 'task_check'
  | 'dispatch'
  /** 控制台配置变更（2026-09-11 审计留痕）：员工/能力/渠道/Skill 终审等后台写操作，
   *  taskId/employeeId 用 'console' 伪标识，payload 带 operator（API token 身份） */
  | 'config_change';

export interface AgentEvent {
  id: string;
  ts: number;
  taskId: string;
  /** 调度事件（dispatch）为 'scheduler'；员工事件为员工 id */
  employeeId: string;
  type: AgentEventType;
  summary: string;
  payload?: unknown;
}
