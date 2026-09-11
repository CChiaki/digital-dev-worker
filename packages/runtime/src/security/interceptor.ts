import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core';
import type { ToolInterceptor } from './types.js';

/** 拦截器链 → pi beforeToolCall。首个 block 生效；全放行返回 undefined。
 *  被拦调用由 pi 产生 isError toolResult 回灌模型，循环不终止、模型可自纠偏（P0-S2）。 */
export function makeBeforeToolCall(
  interceptors: ToolInterceptor[],
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  return async (ctx) => {
    for (const icpt of interceptors) {
      const verdict = icpt.check({
        toolName: ctx.toolCall.name,
        args: (ctx.args as Record<string, unknown>) ?? {},
      });
      if (verdict) {
        return { block: true, reason: `[${icpt.name}] ${verdict.reason}` };
      }
    }
    return undefined;
  };
}
