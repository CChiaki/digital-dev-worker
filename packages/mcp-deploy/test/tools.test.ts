import { describe, it, expect } from 'vitest';
import { createDeployTools } from '../src/tools.js';
import type { DeployTransport, DeployInfo, DeployEnv } from '../src/transport.js';
import type { Tool } from '@ddw/runtime';

class FakeDeploy implements DeployTransport {
  calls: unknown[] = [];
  private poll = 0;
  constructor(private statuses: DeployInfo['status'][] = ['deploying', 'done']) {}
  async deploy(req: { project: string; env: DeployEnv; version: string }): Promise<{ id: string; status: string }> {
    this.calls.push({ method: 'deploy', args: req });
    return { id: 'D-77', status: 'deploying' };
  }
  async getDeploy(id: string): Promise<DeployInfo> {
    this.calls.push({ method: 'getDeploy', args: { id } });
    return { id, status: this.statuses[Math.min(this.poll++, this.statuses.length - 1)] };
  }
}

const tools = (t: DeployTransport, waitOpts?: { intervalMs?: number; timeoutMs?: number; allowedEnvs?: string[] }): Map<string, Tool> =>
  new Map(createDeployTools({ transport: t, waitOpts }).map((x) => [x.name, x]));

describe('deploy_to_env', () => {
  it('发起部署，env/version 正确', async () => {
    const t = new FakeDeploy();
    const r = await tools(t).get('deploy_to_env')!.execute({ project: 'crm/crm-web', env: 'test', version: '1.2.3' });
    expect(r).toEqual({ ok: true, data: { id: 'D-77', status: 'deploying' } });
    expect((t.calls[0] as { args: unknown }).args).toEqual({ project: 'crm/crm-web', env: 'test', version: '1.2.3' });
  });

  it('非法 env 拒绝（只允许 test/staging）', async () => {
    const r = await tools(new FakeDeploy()).get('deploy_to_env')!.execute({ project: 'p', env: 'prod', version: '1' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('prod');
  });

  it('缺参数 → ok:false', async () => {
    expect((await tools(new FakeDeploy()).get('deploy_to_env')!.execute({ project: 'p', env: 'test' })).ok).toBe(false);
  });

  it('allowedEnvs 注入（2026-09-05）：自定义环境名可部署，白名单外仍拒绝（缺省不传保持 test/staging 零回归）', async () => {
    const mk = (allowedEnvs?: string[]): Map<string, Tool> =>
      new Map(createDeployTools({ transport: new FakeDeploy(), ...(allowedEnvs ? { allowedEnvs } : {}) }).map((x) => [x.name, x]));
    // 配置注入 web → web 可部署、prod 拒绝且提示可用环境
    const okR = await mk(['web']).get('deploy_to_env')!.execute({ project: 'p', env: 'web', version: 'v1' });
    expect(okR.ok).toBe(true);
    const badR = await mk(['web']).get('deploy_to_env')!.execute({ project: 'p', env: 'prod', version: 'v1' });
    expect(badR.ok).toBe(false);
    expect((badR as { error: string }).error).toContain('web');
    // 不传 allowedEnvs → 零回归：web 仍被拒（旧白名单 test/staging）
    const legacyR = await mk().get('deploy_to_env')!.execute({ project: 'p', env: 'web', version: 'v1' });
    expect(legacyR.ok).toBe(false);
    expect((legacyR as { error: string }).error).toContain('test/staging');
  });
});

describe('deploy_wait', () => {
  it('轮询到 done', async () => {
    const t = new FakeDeploy(['deploying', 'done']);
    const r = await tools(t, { intervalMs: 1 }).get('deploy_wait')!.execute({ id: 'D-77' });
    expect(r).toMatchObject({ ok: true, data: { status: 'done' } });
  }, 15_000);

  it('failed 终态 → ok:false', async () => {
    const t = new FakeDeploy(['failed']);
    const r = await tools(t, { intervalMs: 1 }).get('deploy_wait')!.execute({ id: 'D-1' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('failed');
  }, 15_000);

  it('超时 → ok:false', async () => {
    const t = new FakeDeploy(['pending']);
    const r = await tools(t, { intervalMs: 1, timeoutMs: 80 }).get('deploy_wait')!.execute({ id: 'D-1' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('超时');
  }, 15_000);
});
