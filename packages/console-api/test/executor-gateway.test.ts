import { describe, expect, it } from 'vitest';
import { ModelGateway } from '@ddw/runtime';
import { resolveExecutorGateway } from '../src/team/executor.js';

describe('resolveExecutorGateway（员工专属模型，2026-09-06 增补）', () => {
  const base = new ModelGateway([{ callType: 'code', primary: { name: 'g', baseUrl: 'http://g/v1', apiKey: 'k', model: 'global-m' } }]);
  const bound = { name: 'emp-m', baseUrl: 'http://e.local/v1', apiKey: 'ek', model: 'emp-m', api: 'anthropic-messages' as const };

  it('有绑定 → 专属 gateway（modelFor(code) 取员工模型，协议随 api）', () => {
    const gw = resolveExecutorGateway(base, bound);
    expect(gw).not.toBe(base);
    // EmployeeRuntime 缺省 callType='code'（employee-runtime.ts deps.callType ?? 'code'）：
    // 绑定必须落在 code 路由，否则执行抛「未配置的调用类型: code」（2026-09-10 修复回归锚点）
    const m = gw.modelFor('code');
    expect(m.id).toBe('emp-m');
    expect(m.api).toBe('anthropic-messages');
    expect(m.headers).toHaveProperty('x-api-key', 'ek');
  });

  it('未绑定 → 原样返回全局 gateway（零回归）', () => {
    expect(resolveExecutorGateway(base)).toBe(base);
    expect(resolveExecutorGateway(base, undefined)).toBe(base);
  });
});
