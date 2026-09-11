import { reactive } from 'vue';
import type { AgentEvent } from '@ddw/runtime';
import type { MessageView } from './api.js';
import { apiToken } from './api.js';

/** 实时角标（与后端 /api/messages/stream counts 事件对齐，2026-09-10 推送改造） */
export interface LiveCounts {
  unread: number;
  checksPending: number;
  skillsPending: number;
  connected: boolean;
}

type MessageListener = (m: MessageView) => void;
export type AgentEventListener = (e: AgentEvent) => void;

// 单例推送连接（2026-09-10 消息改推送不轮询）：全应用共享一条 EventSource——
// 顶栏铃铛、左侧菜单角标、消息弹窗都从这一个状态读；EventSource 断线自动重连，
// 重连后服务端 counts 快照自愈（connected 仅作诊断展示，不驱动交互）
const state = reactive<LiveCounts>({ unread: 0, checksPending: 0, skillsPending: 0, connected: false });
const listeners = new Set<MessageListener>();
let source: EventSource | null = null;

function connect(): void {
  if (source || typeof EventSource === 'undefined') return; // jsdom 等无 EventSource 环境静默跳过
  // token 走 query（2026-09-11 服务端 auth 鉴权）：EventSource 无法自定义请求头；
  // 未启用鉴权/未录入 token 时不带参数，服务端照常放行
  const t = apiToken();
  source = new EventSource(`/api/messages/stream${t ? `?token=${encodeURIComponent(t)}` : ''}`);
  source.addEventListener('counts', (e) => {
    state.connected = true;
    Object.assign(state, JSON.parse((e as MessageEvent).data) as Partial<LiveCounts>);
  });
  source.addEventListener('message', (e) => {
    const m = JSON.parse((e as MessageEvent).data) as MessageView;
    for (const fn of listeners) fn(m);
  });
  source.onerror = () => { state.connected = false; };
}

/** 取实时角标（首个调用建立推送连接）：unread 消息未读 / checksPending 待放行 / skillsPending Skill 待审查 */
export function useLiveCounts(): LiveCounts {
  connect();
  return state;
}

/** 订阅新消息推送（返回退订函数）：消息中心弹通知用 */
export function onLiveMessage(fn: MessageListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// —— agent 事件直播订阅（2026-09-11 P2 产品批）——
// /api/events/stream 全应用共享一条 EventSource（与 messages 流同一单例范式）。
// 只订增量（since = 订阅时刻）：历史由各页面 API 自行拉取，重连不回放全量。
// EventSource 重连复用静态 URL（since 不变），服务端会重推订阅时刻之后的全部事件——
// 客户端按事件 id 幂等去重（同 ts 的新事件不误杀，回放的旧事件不重复分发）。
const agentListeners = new Set<AgentEventListener>();
const agentState = reactive<{ connected: boolean }>({ connected: false });
let agentSource: EventSource | null = null;
let agentSince = 0;
const seenIds = new Set<string>(); // 已投递事件 id（回放去重；上限截断防长连接无限增长）
const SEEN_CAP = 2_000;

function connectAgentStream(): void {
  if (agentSource || typeof EventSource === 'undefined') return; // jsdom 等无 EventSource 环境静默跳过（视图降级轮询）
  agentSince = Date.now();
  const t = apiToken();
  agentSource = new EventSource(`/api/events/stream?since=${agentSince}${t ? `&token=${encodeURIComponent(t)}` : ''}`);
  agentSource.addEventListener('agent-event', (e) => {
    agentState.connected = true;
    const ev = JSON.parse((e as MessageEvent).data) as AgentEvent;
    if (seenIds.has(ev.id)) return; // 重连回放去重
    seenIds.add(ev.id);
    if (seenIds.size > SEEN_CAP) seenIds.delete(seenIds.values().next().value as string);
    for (const fn of agentListeners) fn(ev);
  });
  agentSource.onerror = () => { agentState.connected = false; };
}

/** 订阅 agent 事件直播（返回退订函数；首个订阅者建立连接）。
 *  connected 供视图判断是否降级轮询：SSE 不通（未启用/代理掐断）时视图自行起 interval 兜底 */
export function onAgentEvent(fn: AgentEventListener): { off: () => void; connected: () => boolean } {
  agentListeners.add(fn);
  connectAgentStream();
  return {
    off: () => agentListeners.delete(fn),
    connected: () => agentState.connected,
  };
}
