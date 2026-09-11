import type { IncomingMessage } from 'node:http';

/**
 * API 准入闸（2026-09-11 P0 安全批）：server.ts 在路由分发前的三道防线——
 * 1. token 鉴权：yaml auth.tokens 非空即启用，`Authorization: Bearer <t>` 或 `?token=<t>`
 *    （EventSource 无法自定义请求头，SSE 端点必须支持 query 传参）；
 *    匹配即注入 operator（放行/配置变更审计留痕「谁操作的」）；
 * 2. 请求体上限：无上限拼 Buffer 可被单请求 OOM（yaml 任务包正常 <100KB，10MB 足够宽裕）；
 * 3. 按 IP 限流：内存滑动窗口（单机部署够用；多实例部署需换集中式计数，当前形态不涉及）。
 * 全部为进程内状态、零依赖——契合内网离线原则。缺省（不配 auth）鉴权关闭，其余两道恒开。
 */

export interface GuardOptions {
  /** 具名 token（token → 操作者名）；缺省/空 = 鉴权关闭（内网零回归） */
  tokens?: { name: string; token: string }[];
  /** 请求体上限字节（缺省 10MB） */
  bodyLimitBytes?: number;
  /** 滑动窗口限流（缺省 60s 内 300 次；SSE 重连/前端轮询叠加远低于此） */
  rateLimit?: { windowMs?: number; max?: number };
}

export type AuthorizeResult =
  | { ok: true; operator?: string }
  | { ok: false; status: 401; error: string };

export class ApiGuard {
  private readonly tokenMap: Map<string, string>;
  /** 请求体上限字节（public readonly：413 文案与测试读取） */
  readonly bodyLimitBytes: number;
  private readonly windowMs: number;
  private readonly max: number;
  /** IP → 窗口内请求时间戳（懒清理：每次命中剪枝，无定时器） */
  private readonly hits = new Map<string, number[]>();

  constructor(opts: GuardOptions = {}) {
    this.tokenMap = new Map((opts.tokens ?? []).map((t) => [t.token, t.name]));
    this.bodyLimitBytes = opts.bodyLimitBytes ?? 10 * 1024 * 1024;
    this.windowMs = opts.rateLimit?.windowMs ?? 60_000;
    this.max = opts.rateLimit?.max ?? 300;
  }

  /** 是否启用鉴权（未配置 tokens = 关闭，server 启动日志与 doctor 巡检都读它） */
  get authEnabled(): boolean {
    return this.tokenMap.size > 0;
  }

  /**
   * 鉴权：Bearer 头优先，query `token` 兜底（SSE 场景）。
   * 鉴权关闭时恒过且不注入 operator（无身份可言，留痕字段缺省）。
   */
  authorize(headers: IncomingMessage['headers'], query: Record<string, string>): AuthorizeResult {
    if (!this.authEnabled) return { ok: true };
    const header = headers.authorization;
    const fromHeader = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const token = fromHeader || query.token;
    if (!token) {
      return { ok: false, status: 401, error: '未授权：缺少 API token（Authorization: Bearer <token> 或 ?token=）' };
    }
    const operator = this.tokenMap.get(token);
    if (!operator) {
      return { ok: false, status: 401, error: '未授权：API token 无效' };
    }
    return { ok: true, operator };
  }

  /** 请求体累计字节数是否超限（超限调用方应立即 413 并 destroy 连接止损） */
  bodyTooLarge(received: number): boolean {
    return received > this.bodyLimitBytes;
  }

  /** 记录一次命中并判断是否超限（超限本次拒绝；窗口滑动后自动恢复） */
  rateLimited(ip: string, now = Date.now()): boolean {
    const windowStart = now - this.windowMs;
    const list = (this.hits.get(ip) ?? []).filter((t) => t >= windowStart);
    list.push(now);
    this.hits.set(ip, list);
    return list.length > this.max;
  }
}
