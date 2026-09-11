import { describe, it, expect } from 'vitest';
import { createGitLabTools } from '../src/tools.js';
import type { GitLabTransport, GitLabResponse } from '../src/transport.js';
import type { Tool } from '@ddw/runtime';

/** fake transport：按 (method, path 前缀) 匹配返回，记录全部请求 */
class FakeTransport implements GitLabTransport {
  calls: { method: string; path: string; body?: unknown }[] = [];
  constructor(private routes: {
    match: (method: string, path: string) => boolean;
    respond: (method: string, path: string, body?: unknown) => GitLabResponse;
  }[]) {}

  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<GitLabResponse> {
    this.calls.push({ method, path, body });
    const r = this.routes.find((r) => r.match(method, path));
    if (!r) return { status: 404, json: { message: 'not mocked' } };
    return r.respond(method, path, body);
  }
}

const tools = (t: FakeTransport): Map<string, Tool> =>
  new Map(createGitLabTools({ transport: t, defaultRepo: 'frontend/web-app' }).map((tool) => [tool.name, tool]));

describe('gitlab_create_branch', () => {
  it('新建分支走 POST query 参数', async () => {
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('/branches/feature%2Fnew'), respond: () => ({ status: 404, json: {} }) },
      {
        match: (m, p) => m === 'POST' && p.includes('/repository/branches?'),
        respond: () => ({ status: 201, json: { name: 'feature/new' } }),
      },
    ]);
    const r = await tools(t).get('gitlab_create_branch')!.execute({ repo: 'frontend/web-app', branch: 'feature/new', from: 'develop' });
    expect(r.ok).toBe(true);
    const post = t.calls.at(-1)!;
    expect(post.path).toContain('/projects/frontend%2Fweb-app/repository/branches?branch=feature%2Fnew&ref=develop');
  });

  it('分支已存在视为成功（幂等）', async () => {
    const t = new FakeTransport([
      { match: (m) => m === 'GET', respond: () => ({ status: 200, json: { name: 'feature/new' } }) },
    ]);
    const r = await tools(t).get('gitlab_create_branch')!.execute({ branch: 'feature/new', from: 'develop' });
    expect(r).toEqual({ ok: true, data: { branch: 'feature/new', existed: true } });
  });
});

describe('gitlab_commit_files', () => {
  it('多文件单 commit，自动判断 create/update；message 自动补全「修改文件:」清单', async () => {
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('index.vue'), respond: () => ({ status: 200, json: {} }) },
      { match: (m, p) => m === 'GET' && p.includes('auth.ts'), respond: () => ({ status: 404, json: {} }) },
      { match: (m, p) => m === 'POST' && p.includes('/repository/commits'), respond: () => ({ status: 201, json: { commit_id: 'abc123' } }) },
    ]);
    const r = await tools(t).get('gitlab_commit_files')!.execute({
      repo: 'frontend/web-app', branch: 'feature/new',
      message: 'feat(feature/new): 登录重构\n\n内容点:\n- src/views/login/index.vue: 重构登录表单\n- src/api/auth.ts: 新增登出接口',
      files: [
        { path: 'src/views/login/index.vue', content: '<template/>' },
        { path: 'src/api/auth.ts', content: 'export {}' },
      ],
    });
    expect(r).toMatchObject({ ok: true, data: { commit_id: 'abc123' } });
    const post = t.calls.at(-1)!;
    const body = post.body as { commit_message: string; actions: { action: string; file_path: string }[] };
    // 提交规范（2026-09-09，2026-09-10 增分支名）：内容点保留 + 修改文件清单自动补全
    expect(body.commit_message).toBe(
      'feat(feature/new): 登录重构\n\n内容点:\n- src/views/login/index.vue: 重构登录表单\n- src/api/auth.ts: 新增登出接口\n\n修改文件:\n- src/views/login/index.vue\n- src/api/auth.ts',
    );
    expect(body.actions).toEqual([
      { action: 'update', file_path: 'src/views/login/index.vue', content: '<template/>', encoding: 'text' },
      { action: 'create', file_path: 'src/api/auth.ts', content: 'export {}', encoding: 'text' },
    ]);
  });

  it('提交规范：首行缺「类型(分支):」前缀（2026-09-10 增分支名）→ 拒绝执行', async () => {
    const t = new FakeTransport([]);
    const r = await tools(t).get('gitlab_commit_files')!.execute({
      branch: 'feature/new', message: 'feat: 登录重构\n\n内容点:\n- src/a.ts: x',
      files: [{ path: 'src/a.ts', content: 'x' }],
    });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('类型(分支)');
    expect(t.calls).toHaveLength(0); // 未发起任何远端请求
  });

  it('提交规范：首行括号内分支与目标分支不一致 → 拒绝执行', async () => {
    const t = new FakeTransport([]);
    const r = await tools(t).get('gitlab_commit_files')!.execute({
      branch: 'feature/new', message: 'feat(main): 登录重构\n\n内容点:\n- src/a.ts: x',
      files: [{ path: 'src/a.ts', content: 'x' }],
    });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('不一致');
    expect((r as { error: string }).error).toContain('feature/new');
    expect(t.calls).toHaveLength(0);
  });

  it('提交规范：类型不在允许清单 → 拒绝执行', async () => {
    const t = new FakeTransport([]);
    const r = await tools(t).get('gitlab_commit_files')!.execute({
      branch: 'b', message: 'update(b): 登录重构\n\n内容点:\n- src/a.ts: x',
      files: [{ path: 'src/a.ts', content: 'x' }],
    });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('不在允许清单');
  });

  it('提交规范：缺「内容点:」段落 → 拒绝执行并内嵌格式模板', async () => {
    const t = new FakeTransport([]);
    const r = await tools(t).get('gitlab_commit_files')!.execute({
      branch: 'b', message: 'feat(b): 登录重构',
      files: [{ path: 'src/a.ts', content: 'x' }],
    });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('内容点');
    expect((r as { error: string }).error).toContain('示例');
    expect(t.calls).toHaveLength(0); // 未发起任何远端请求
  });

  it('提交规范：「内容点:」段落为空 → 拒绝执行', async () => {
    const t = new FakeTransport([]);
    const r = await tools(t).get('gitlab_commit_files')!.execute({
      branch: 'b', message: 'feat(b): 登录重构\n\n内容点:',
      files: [{ path: 'src/a.ts', content: 'x' }],
    });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('段落为空');
  });

  it('files 为空返回错误结果', async () => {
    const t = new FakeTransport([]);
    const r = await tools(t).get('gitlab_commit_files')!.execute({ branch: 'b', files: [], message: 'x' });
    expect(r.ok).toBe(false);
  });
});

describe('gitlab_create_mr', () => {
  it('创建 MR 并返回 iid/url', async () => {
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('/merge_requests?'), respond: () => ({ status: 200, json: [] }) },
      { match: (m, p) => m === 'POST' && p.endsWith('/merge_requests'), respond: () => ({ status: 201, json: { iid: 42, web_url: 'http://gitlab.inner.bank/frontend/web-app/-/merge_requests/42' } }) },
    ]);
    const r = await tools(t).get('gitlab_create_mr')!.execute({
      repo: 'frontend/web-app', source: 'feature/new', target: 'develop', title: '登录重构', description: 'done',
    });
    expect(r).toEqual({
      ok: true,
      data: { iid: 42, url: 'http://gitlab.inner.bank/frontend/web-app/-/merge_requests/42', existed: false },
    });
    const post = t.calls.at(-1)!;
    expect(post.body).toMatchObject({ source_branch: 'feature/new', target_branch: 'develop', title: '登录重构' });
  });

  it('已有 opened MR 时幂等返回已有', async () => {
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET', respond: () => ({ status: 200, json: [{ iid: 7, web_url: 'http://x/mr/7' }] }) },
    ]);
    const r = await tools(t).get('gitlab_create_mr')!.execute({
      repo: 'r', source: 'feature/new', target: 'develop', title: 'x',
    });
    expect(r).toEqual({ ok: true, data: { iid: 7, url: 'http://x/mr/7', existed: true } });
    expect(t.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('gitlab_get_mr / gitlab_get_file / 错误路径', () => {
  it('get_mr 抽取 state/merge_status', async () => {
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('/merge_requests/42'), respond: () => ({ status: 200, json: { state: 'opened', merge_status: 'can_be_merged', web_url: 'http://x/42', title: '登录重构' } }) },
    ]);
    const r = await tools(t).get('gitlab_get_mr')!.execute({ repo: 'r', mr_iid: 42 });
    expect(r).toMatchObject({ ok: true, data: { state: 'opened', merge_status: 'can_be_merged' } });
  });

  it('get_file base64 解码', async () => {
    const b64 = Buffer.from('export const a = 1', 'utf8').toString('base64');
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('/files/'), respond: () => ({ status: 200, json: { content: b64, encoding: 'base64' } }) },
    ]);
    const r = await tools(t).get('gitlab_get_file')!.execute({ repo: 'r', branch: 'main', path: 'src/a.ts' });
    expect(r).toEqual({ ok: true, data: { path: 'src/a.ts', content: 'export const a = 1' } });
  });

  it('非 2xx → ok:false 且 error 带 status 与 body', async () => {
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('/merge_requests/'), respond: () => ({ status: 405, json: { message: 'Method Not Allowed' } }) },
    ]);
    const r = await tools(t).get('gitlab_get_mr')!.execute({ repo: 'r', mr_iid: 1 });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('GitLab 405');
    expect((r as { error: string }).error).toContain('Method Not Allowed');
  });
});
