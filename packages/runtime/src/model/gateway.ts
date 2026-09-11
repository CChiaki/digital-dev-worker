import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { streamSimple as openaiStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as anthropicStreamSimple } from '@earendil-works/pi-ai/api/anthropic-messages';
import type { CallType, ModelApi, ModelSpec, RouteConfig } from '../types.js';

/** pi Model 的产品级默认值（行内模型按需覆盖） */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
/** 单次模型请求缺省超时（2026-09-11 P0 韧性批）：ModelSpec.timeoutMs 可按路由覆盖；
 *  覆盖请求建立 + 流式收包全程（AbortSignal.timeout 传入 pi-ai → fetch） */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * 协议 → pi-ai 缺省流式适配器（streamFnFor 未显式注入时按路由协议选）。
 * 导出供测试断言缺省分派引用。
 */
export const DEFAULT_STREAM: Record<ModelApi, StreamFn> = {
  'openai-completions': openaiStreamSimple as StreamFn,
  'anthropic-messages': anthropicStreamSimple as StreamFn,
};

function toPiModel(spec: ModelSpec): Model<ModelApi> {
  const api = spec.api ?? 'openai-completions';
  return {
    id: spec.model,
    name: spec.name,
    api,
    provider: 'ddw-custom',
    baseUrl: spec.baseUrl.replace(/\/$/, ''),
    // anthropic 协议标记 reasoning：pi-agent-core Agent 缺省 thinkingLevel="off" 时，
    // anthropic-messages 适配器据此在请求体显式带 thinking:{type:"disabled"} 关闭思考模式
    // （2026-09-05 智谱端点实测接受，返回纯正文无思考块；开启思考后续单独处理）。
    // openai 私有集群维持 false
    reasoning: api === 'anthropic-messages',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    // openai → Bearer；anthropic → x-api-key（anthropic-version 由 SDK 默认补）
    headers:
      api === 'anthropic-messages'
        ? { 'x-api-key': spec.apiKey }
        : { Authorization: `Bearer ${spec.apiKey}` },
  };
}

export class ModelGateway {
  private readonly routes: Map<CallType, RouteConfig>;

  constructor(routes: RouteConfig[]) {
    this.routes = new Map(routes.map((r) => [r.callType, r]));
  }

  modelFor(callType: CallType): Model<ModelApi> {
    const route = this.routes.get(callType);
    if (!route) throw new Error(`未配置的调用类型: ${callType}`);
    return toPiModel(route.primary);
  }

  /**
   * 返回带超时/重试/fallback 的 StreamFn（2026-09-11 P0 韧性批）：
   * - 超时：primary/fallback 各自 ModelSpec.timeoutMs（缺省 120s）——AbortSignal.timeout 传入
   *   pi-ai（→ fetch），覆盖请求建立 + 流式收包；调用方自带的 signal 与超时合并（任一触发即断）
   * - 重试：maxRetries=1 启用 pi-ai 内建 provider 重试（此前恒 0 一次失败即整轮 failed）——
   *   429/5xx/网络错按 SDK 语义退避（尊重 retry-after），AbortError（超时/外部取消）不重试
   * - fallback：primary 失败（含重试耗尽）切 fallback 同轮重试（各带自己的超时与重试）
   * stream 参数可注入 fake（测试）；缺省按路由协议选适配器（primary/fallback 各自独立，
   * 跨协议 fallback 可用）。
   */
  streamFnFor(
    callType: CallType,
    stream: StreamFn = DEFAULT_STREAM[this.routes.get(callType)?.primary.api ?? 'openai-completions'],
    fallbackStream?: StreamFn,
  ): StreamFn {
    const route = this.routes.get(callType);
    const fallbackSpec = route?.fallback;
    return async (model, context, options) => {
      // pi-ai 适配器的认证预检（openai getClientApiKey / anthropic assertRequestAuth）
      // 只看 options.apiKey / options.headers，不看 model.headers；而 pi-agent-core 的
      // agent-loop 只传 {...config, apiKey}（不含 headers）。这里把 model.headers 注入
      // options.headers（显式传入的 options.headers 优先），保证认证头可达适配器。
      const call = (fn: StreamFn, m: typeof model, timeoutMs: number) =>
        fn(m, context, {
          ...options,
          // 超时信号与调用方信号合并（agent-loop 取消/我们超时任一触发即断流）；
          // AbortSignal.timeout 自带释放，长会话不积压
          signal: options?.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
          maxRetries: 1,
          headers: { ...m.headers, ...options?.headers },
        });
      try {
        return await call(stream, model, this.routes.get(callType)?.primary.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      } catch (err) {
        if (!fallbackSpec) throw err;
        const fb = fallbackStream ?? DEFAULT_STREAM[fallbackSpec.api ?? 'openai-completions'];
        const fbModel = toPiModel(fallbackSpec);
        return await call(fb, fbModel, fallbackSpec.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      }
    };
  }
}
