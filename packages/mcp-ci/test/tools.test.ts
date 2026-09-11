import { describe, it, expect } from 'vitest';
import { createCiTools } from '../src/tools.js';
import type { CiTransport, BuildInfo } from '../src/transport.js';
import type { Tool } from '@ddw/runtime';

/** 可编程状态机：按次数推进构建状态，记录调用 */
class FakeCi implements CiTransport {
  calls: { method: string; args: unknown }[] = [];
  private pollCount = 0;
  constructor(
    private statuses: BuildInfo['status'][] = ['created', 'running', 'success'],
    private log = '[INFO] build ok\nDONE',
    private fail?: (method: string) => boolean,
  ) {}

  async triggerBuild(req: { project: string; ref: string }): Promise<{ id: string }> {
    this.calls.push({ method: 'triggerBuild', args: req });
    if (this.fail?.('triggerBuild')) throw new Error('CI 503: runner 不可用');
    return { id: 'B-9001' };
  }

  async getBuild(id: string): Promise<BuildInfo> {
    this.calls.push({ method: 'getBuild', args: { id } });
    if (this.fail?.('getBuild')) throw new Error('CI 500');
    const status = this.statuses[Math.min(this.pollCount++, this.statuses.length - 1)];
    return { id, status };
  }

  async getLog(id: string, tailLines?: number): Promise<string> {
    this.calls.push({ method: 'getLog', args: { id, tailLines } });
    const lines = this.log.split('\n');
    return tailLines ? lines.slice(-tailLines).join('\n') : this.log;
  }
}

const tools = (t: CiTransport, waitOpts?: { intervalMs?: number; timeoutMs?: number }): Map<string, Tool> =>
  new Map(createCiTools({ transport: t, waitOpts }).map((x) => [x.name, x]));

describe('ci_trigger_build', () => {
  it('触发构建，请求体正确', async () => {
    const t = new FakeCi();
    const r = await tools(t).get('ci_trigger_build')!.execute({ project: 'crm/crm-web', ref: 'feature/x' });
    expect(r).toEqual({ ok: true, data: { id: 'B-9001', status: 'created' } });
    expect(t.calls[0].args).toEqual({ project: 'crm/crm-web', ref: 'feature/x' });
  });

  it('缺参数 / transport 抛错 → ok:false', async () => {
    expect((await tools(new FakeCi()).get('ci_trigger_build')!.execute({ project: 'p' })).ok).toBe(false);
    const bad = new FakeCi([], '', () => true);
    const r = await tools(bad).get('ci_trigger_build')!.execute({ project: 'p', ref: 'main' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('503');
  });
});

describe('ci_get_build', () => {
  it('透传状态', async () => {
    const t = new FakeCi(['failed']);
    const r = await tools(t).get('ci_get_build')!.execute({ id: 'B-1' });
    expect(r).toEqual({ ok: true, data: { id: 'B-1', status: 'failed' } });
  });
});

describe('ci_wait_build（轮询到终态）', () => {
  it('created→running→success 轮询后返回 success', async () => {
    const t = new FakeCi(['created', 'running', 'success']);
    const r = await tools(t, { intervalMs: 1 }).get('ci_wait_build')!.execute({ id: 'B-9001' });
    expect(r).toMatchObject({ ok: true, data: { status: 'success' } });
    // 至少轮询 3 次
    const polls = t.calls.filter((c) => c.method === 'getBuild').length;
    expect(polls).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it('终态为 failed → ok:false（构建失败带状态）', async () => {
    const t = new FakeCi(['failed']);
    const r = await tools(t, { intervalMs: 1 }).get('ci_wait_build')!.execute({ id: 'B-1' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('failed');
  }, 15_000);

  it('超时 → ok:false 提示超时', async () => {
    const t = new FakeCi(['running']); // 永远 running
    const r = await tools(t, { intervalMs: 1, timeoutMs: 100 }).get('ci_wait_build')!.execute({ id: 'B-1' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('超时');
  }, 15_000);
});

describe('ci_get_log', () => {
  it('tail 参数截取尾部', async () => {
    const t = new FakeCi([], 'l1\nl2\nl3\nl4');
    const r = await tools(t).get('ci_get_log')!.execute({ id: 'B-1', tail: 2 });
    expect(r).toEqual({ ok: true, data: { log: 'l3\nl4' } });
  });

  it('无 tail 返回全量', async () => {
    const t = new FakeCi([], 'l1\nl2');
    const r = await tools(t).get('ci_get_log')!.execute({ id: 'B-1' });
    expect((r as { data: { log: string } }).data.log).toBe('l1\nl2');
  });
});
