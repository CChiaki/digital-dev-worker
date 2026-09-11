import { describe, it, expect } from 'vitest';
import { createTestenvTools } from '../src/tools.js';
import type { TestenvTransport } from '../src/transport.js';
import type { Tool } from '@ddw/runtime';

class FakeTestenv implements TestenvTransport {
  calls: string[] = [];
  constructor(private res: { status: number; body: string }, private fail?: boolean) {}
  async check(url: string): Promise<{ status: number; body: string }> {
    this.calls.push(url);
    if (this.fail) throw new Error('ECONNREFUSED 10.2.3.4:8080');
    return this.res;
  }
}

const tools = (t: TestenvTransport): Map<string, Tool> =>
  new Map(createTestenvTools({ transport: t }).map((x) => [x.name, x]));

describe('testenv_check_health', () => {
  it('200 且包含关键文案 → ok', async () => {
    const t = new FakeTestenv({ status: 200, body: 'UP · crm-web 1.2.3' });
    const r = await tools(t).get('testenv_check_health')!.execute({
      url: 'http://testenv.local/crm/health', contains: 'UP',
    });
    expect(r).toEqual({ ok: true, data: { status: 200, healthy: true } });
    expect(t.calls[0]).toBe('http://testenv.local/crm/health');
  });

  it('200 但关键文案缺失 → ok:false', async () => {
    const t = new FakeTestenv({ status: 200, body: 'UP' });
    const r = await tools(t).get('testenv_check_health')!.execute({
      url: 'http://x/health', contains: '1.2.3',
    });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('1.2.3');
  });

  it('非 200 → ok:false 带状态码', async () => {
    const t = new FakeTestenv({ status: 502, body: 'Bad Gateway' });
    const r = await tools(t).get('testenv_check_health')!.execute({ url: 'http://x/health' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('502');
  });

  it('网络不可达 → ok:false 带原因', async () => {
    const t = new FakeTestenv({ status: 0, body: '' }, true);
    const r = await tools(t).get('testenv_check_health')!.execute({ url: 'http://x/health' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('ECONNREFUSED');
  });
});

describe('testenv_get_page', () => {
  it('返回页面内容（轻量验证通道）', async () => {
    const t = new FakeTestenv({ status: 200, body: '<html>登录页</html>' });
    const r = await tools(t).get('testenv_get_page')!.execute({ url: 'http://x/login' });
    expect(r).toEqual({ ok: true, data: { status: 200, body: '<html>登录页</html>' } });
  });

  it('缺 url → ok:false', async () => {
    expect((await tools(new FakeTestenv({ status: 200, body: '' })).get('testenv_get_page')!.execute({})).ok).toBe(false);
  });
});
