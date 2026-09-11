import { describe, it, expect } from 'vitest';
import { ApiGuard } from '../src/http/guard.js';

/**
 * API 准入闸（2026-09-11 P0 安全批）：token 鉴权（Bearer / query 兜底）+ 请求体上限 + IP 限流。
 * 纯内存逻辑，直测不监听端口。
 */

const TOKENS = [
  { name: '张三', token: 'tok-a' },
  { name: '李四', token: 'tok-b' },
];

describe('ApiGuard 鉴权（2026-09-11）', () => {
  it('未配置 tokens = 鉴权关闭：无头也放行且不注入 operator（内网零回归）', () => {
    const g = new ApiGuard({});
    expect(g.authEnabled).toBe(false);
    expect(g.authorize({}, {})).toEqual({ ok: true });
  });

  it('Bearer 头匹配 → 注入 operator（token → 操作者名）', () => {
    const g = new ApiGuard({ tokens: TOKENS });
    expect(g.authEnabled).toBe(true);
    expect(g.authorize({ authorization: 'Bearer tok-a' }, {})).toEqual({ ok: true, operator: '张三' });
  });

  it('query token 兜底（EventSource 无法设请求头）', () => {
    const g = new ApiGuard({ tokens: TOKENS });
    expect(g.authorize({}, { token: 'tok-b' })).toEqual({ ok: true, operator: '李四' });
  });

  it('无 token / 错 token → 401 可读错误', () => {
    const g = new ApiGuard({ tokens: TOKENS });
    const none = g.authorize({}, {});
    expect(none).toMatchObject({ ok: false, status: 401 });
    expect((none as { error: string }).error).toContain('缺少 API token');
    const wrong = g.authorize({ authorization: 'Bearer nope' }, {});
    expect(wrong).toMatchObject({ ok: false, status: 401 });
    expect((wrong as { error: string }).error).toContain('无效');
  });

  it('Bearer 头优先于 query token（两处都给时以头为准）', () => {
    const g = new ApiGuard({ tokens: TOKENS });
    expect(g.authorize({ authorization: 'Bearer tok-a' }, { token: 'tok-b' })).toEqual({ ok: true, operator: '张三' });
  });
});

describe('ApiGuard 请求体上限', () => {
  it('默认 10MB；超限判定正确', () => {
    const g = new ApiGuard({});
    expect(g.bodyLimitBytes).toBe(10 * 1024 * 1024);
    expect(g.bodyTooLarge(10 * 1024 * 1024)).toBe(false);
    expect(g.bodyTooLarge(10 * 1024 * 1024 + 1)).toBe(true);
  });

  it('可自定义上限', () => {
    const g = new ApiGuard({ bodyLimitBytes: 100 });
    expect(g.bodyTooLarge(101)).toBe(true);
  });
});

describe('ApiGuard IP 限流（滑动窗口）', () => {
  it('窗口内超 max 次 → 拒绝；窗口滑出后恢复', () => {
    const g = new ApiGuard({ rateLimit: { windowMs: 1000, max: 3 } });
    const t0 = 1_000_000;
    expect(g.rateLimited('1.1.1.1', t0)).toBe(false);
    expect(g.rateLimited('1.1.1.1', t0 + 100)).toBe(false);
    expect(g.rateLimited('1.1.1.1', t0 + 200)).toBe(false);
    expect(g.rateLimited('1.1.1.1', t0 + 300)).toBe(true);  // 第 4 次超限
    // 旧时间戳滑出窗口后不再计数
    expect(g.rateLimited('1.1.1.1', t0 + 1_500)).toBe(false);
  });

  it('不同 IP 互不影响', () => {
    const g = new ApiGuard({ rateLimit: { windowMs: 1000, max: 1 } });
    expect(g.rateLimited('1.1.1.1')).toBe(false);
    expect(g.rateLimited('2.2.2.2')).toBe(false);
    expect(g.rateLimited('1.1.1.1')).toBe(true);
    expect(g.rateLimited('2.2.2.2')).toBe(true);
  });
});
