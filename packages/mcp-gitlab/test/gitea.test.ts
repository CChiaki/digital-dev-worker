import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGiteaTools, FetchGiteaTransport, commitViaGitCli } from '../src/gitea.js';
import type { GitLabTransport, GitLabResponse } from '../src/transport.js';
import type { Tool } from '@ddw/runtime';

// git CLI mock：记录全部命令调用，rev-parse 返回固定 sha；gitShouldFail 置真模拟本机 git 不可用
const execCalls: string[][] = [];
let gitShouldFail = false;
vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string, args: string[], _opts: unknown,
    cb: (e: Error | null, out?: { stdout: string; stderr: string }) => void,
  ) => {
    execCalls.push([cmd, ...args]);
    if (gitShouldFail) { cb(new Error('git-mock-fail: simulated git failure')); return; }
    if (args[0] === 'rev-parse') cb(null, { stdout: 'feed0001deadbeef\n', stderr: '' });
    else cb(null, { stdout: '', stderr: '' });
  },
}));

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
  new Map(createGiteaTools({
    transport: t,
    defaultRepo: 'demo/web-app',
    // git CLI 兜底路径（多文件单 commit）依赖本机 git 与认证信息
    localGit: { baseUrl: 'http://localhost:3000', token: 'pat-test-1234' },
  }).map((tool) => [tool.name, tool]));

beforeEach(() => {
  execCalls.length = 0;
  gitShouldFail = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gitea_create_branch', () => {
  it('新建分支走 POST body（new_branch_name/old_branch_name），repo 逐段编码', async () => {
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('/branches/feature%2Fnew'), respond: () => ({ status: 404, json: {} }) },
      { match: (m) => m === 'POST', respond: () => ({ status: 201, json: { name: 'feature/new' } }) },
    ]);
    const r = await tools(t).get('gitea_create_branch')!.execute({ branch: 'feature/new', from: 'develop' });
    expect(r.ok).toBe(true);
    const post = t.calls.at(-1)!;
    // repo 走路径分段（不整体 encode 斜杠），body 为 Gitea 字段名
    expect(post.path).toBe('/repos/demo/web-app/branches');
    expect(post.body).toEqual({ new_branch_name: 'feature/new', old_branch_name: 'develop' });
  });

  it('分支已存在视为成功（幂等）且不发 POST', async () => {
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('/branches/main'), respond: () => ({ status: 200, json: { name: 'main' } }) },
    ]);
    const r = await tools(t).get('gitea_create_branch')!.execute({ branch: 'main', from: 'develop' });
    expect(r).toEqual({ ok: true, data: { branch: 'main', existed: true } });
    expect(t.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('gitea_commit_files', () => {
  it('change_files 单 commit：自动判断 create/update，内容 base64', async () => {
    const t = new FakeTransport([
      // index.vue 已存在（update，带 sha）；auth.ts 不存在（create）
      { match: (m, p) => m === 'GET' && p.includes('index.vue'), respond: () => ({ status: 200, json: { sha: 'sha-old' } }) },
      { match: (m, p) => m === 'GET' && p.includes('auth.ts'), respond: () => ({ status: 404, json: {} }) },
      { match: (m, p) => m === 'POST' && p.endsWith('/change_files'), respond: () => ({ status: 200, json: { sha: 'abc123' } }) },
    ]);
    const r = await tools(t).get('gitea_commit_files')!.execute({
      repo: 'demo/web-app', branch: 'feature/new',
      message: 'feat(feature/new): 登录重构\n\n内容点:\n- src/views/login/index.vue: 重构登录表单\n- src/api/auth.ts: 新增登出接口',
      files: [
        { path: 'src/views/login/index.vue', content: '<template/>' },
        { path: 'src/api/auth.ts', content: 'export {}' },
      ],
    });
    expect(r).toMatchObject({ ok: true, data: { commit_id: 'abc123' } });
    const post = t.calls.at(-1)!;
    expect(post.path).toBe('/repos/demo/web-app/change_files');
    const body = post.body as { files: { operation: string; path: string; contents: string; sha?: string }[]; branch: string; message: string };
    expect(body.branch).toBe('feature/new');
    // 提交规范（2026-09-09，2026-09-10 增分支名）：内容点保留 + 修改文件清单自动补全
    expect(body.message).toBe(
      'feat(feature/new): 登录重构\n\n内容点:\n- src/views/login/index.vue: 重构登录表单\n- src/api/auth.ts: 新增登出接口\n\n修改文件:\n- src/views/login/index.vue\n- src/api/auth.ts',
    );
    expect(body.files[0]).toEqual({
      operation: 'update', path: 'src/views/login/index.vue', sha: 'sha-old',
      contents: Buffer.from('<template/>', 'utf8').toString('base64'),
    });
    expect(body.files[1]).toMatchObject({ operation: 'create', path: 'src/api/auth.ts' });
    expect(body.files[1].sha).toBeUndefined();
  });

  it('Gitea 1.27 无 change_files（404）→ 本地 git CLI 单 commit（clone→add→commit→push）', async () => {
    // 2026-09-05 实战缺陷：旧回退逐文件 contents API 每文件一条 commit（3 文件 = 3 条相同
    // message 提交）。Gitea 标准 HTTP API 无法多文件单 commit（git/blobs、git/trees 均 404），
    // 改走本地 git CLI：clone → 写文件 → add/commit → push，天然单条提交。
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('/contents/'), respond: () => ({ status: 404, json: {} }) },
      { match: (m, p) => m === 'POST' && p.endsWith('/change_files'), respond: () => ({ status: 404, json: { message: 'Not Found' } }) },
    ]);
    const r = await tools(t).get('gitea_commit_files')!.execute({
      repo: 'demo/web-app', branch: 'main',
      message: 'feat(main): 单次提交\n\n内容点:\n- index.html: 页面骨架\n- style.css: 基础样式',
      files: [
        { path: 'index.html', content: '<html/>' },
        { path: 'style.css', content: 'body{}' },
      ],
    });
    expect(r).toMatchObject({ ok: true, data: { mode: 'git-cli', commit_id: 'feed0001deadbeef' } });
    // 全程零 contents 逐文件提交（防重复提交回归）
    expect(t.calls.filter((c) => c.method === 'POST' && c.path.includes('/contents/'))).toHaveLength(0);
    expect(t.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    // git 命令序列：clone → add → commit（-c 身份注入）→ push，message 单条
    expect(execCalls.some((c) => c[1] === 'clone')).toBe(true);
    expect(execCalls.some((c) => c[1] === 'add')).toBe(true);
    const commitCall = execCalls.find((c) => c.includes('commit'))!;
    expect(commitCall.filter((a) => a === '-c')).toHaveLength(2); // user.name/user.email 身份注入
    // 提交规范（2026-09-09）：-m 收到补全「修改文件:」后的最终 message
    expect(commitCall[commitCall.indexOf('-m') + 1]).toBe(
      'feat(main): 单次提交\n\n内容点:\n- index.html: 页面骨架\n- style.css: 基础样式\n\n修改文件:\n- index.html\n- style.css',
    );
    expect(execCalls.some((c) => c[1] === 'push')).toBe(true);
  });

  it('change_files 与 git CLI 均失败 → 兜底回退逐文件 contents API（每文件一条 commit）', async () => {
    gitShouldFail = true;
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('auth.ts'), respond: () => ({ status: 404, json: {} }) },
      { match: (m, p) => m === 'POST' && p.endsWith('/change_files'), respond: () => ({ status: 404, json: { message: 'Not Found' } }) },
      { match: (m, p) => m === 'GET' && p.endsWith('/branches/'), respond: () => ({ status: 404, json: {} }) },
      { match: (m, p) => m === 'POST' && p.includes('/contents/'), respond: () => ({ status: 201, json: {} }) },
    ]);
    const r = await tools(t).get('gitea_commit_files')!.execute({
      repo: 'demo/web-app', branch: 'b', message: 'chore(b): x\n\n内容点:\n- src/api/auth.ts: 占位',
      files: [{ path: 'src/api/auth.ts', content: 'export {}' }],
    });
    expect(r).toMatchObject({ ok: true, data: { mode: 'per-file' } });
    const put = t.calls.filter((c) => c.method === 'POST' && c.path.includes('/contents/')).at(-1)!;
    expect(put.path).toBe('/repos/demo/web-app/contents/src%2Fapi%2Fauth.ts');
  });

  it('files 为空返回错误结果', async () => {
    const t = new FakeTransport([]);
    const r = await tools(t).get('gitea_commit_files')!.execute({ branch: 'b', files: [], message: 'x' });
    expect(r.ok).toBe(false);
  });
});

describe('commitViaGitCli（本地 git 单 commit 兜底）', () => {
  it('clone URL 认证可构造；失败信息不含 token', async () => {
    gitShouldFail = true;
    const sha = await commitViaGitCli(
      { baseUrl: 'http://localhost:3000', token: 'pat-secret-9' },
      'demo/web-app', 'main', 'msg',
      [{ path: 'a.txt', content: 'x', exists: false }],
    );
    expect(sha).toBeUndefined();
    // clone 命令的 URL 内嵌认证（git push 需要凭证），但模拟失败的错误信息不含 token
    const clone = execCalls.find((c) => c[1] === 'clone')!;
    expect(clone.some((a) => a.includes('pat-secret-9'))).toBe(true);
  });

  it('成功路径：rev-parse 返回 commit sha', async () => {
    const sha = await commitViaGitCli(
      { baseUrl: 'http://localhost:3000', token: 't' },
      'demo/web-app', 'main', 'msg',
      [{ path: 'a.txt', content: 'x', exists: false }],
    );
    expect(sha).toBe('feed0001deadbeef');
  });
});

describe('gitea_create_mr', () => {  it('创建 PR 并返回 number/html_url（head/base 字段）', async () => {
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('/pulls?'), respond: () => ({ status: 200, json: [] }) },
      { match: (m, p) => m === 'POST' && p.endsWith('/pulls'), respond: () => ({ status: 201, json: { number: 42, html_url: 'http://localhost:3000/demo/web-app/pulls/42' } }) },
    ]);
    const r = await tools(t).get('gitea_create_mr')!.execute({
      repo: 'demo/web-app', source: 'feature/new', target: 'develop', title: '登录重构', description: 'done',
    });
    expect(r).toEqual({
      ok: true,
      data: { iid: 42, url: 'http://localhost:3000/demo/web-app/pulls/42', existed: false },
    });
    const post = t.calls.at(-1)!;
    expect(post.body).toEqual({ head: 'feature/new', base: 'develop', title: '登录重构', body: 'done' });
  });

  it('已有同源同目标 open PR 时幂等返回已有', async () => {
    const t = new FakeTransport([
      {
        match: (m, p) => m === 'GET' && p.includes('/pulls?'),
        respond: () => ({
          status: 200,
          json: [
            { number: 7, html_url: 'http://x/pulls/7', head: { ref: 'feature/other' }, base: { ref: 'develop' } },
            { number: 9, html_url: 'http://x/pulls/9', head: { ref: 'feature/new' }, base: { ref: 'develop' } },
          ],
        }),
      },
    ]);
    const r = await tools(t).get('gitea_create_mr')!.execute({
      repo: 'r', source: 'feature/new', target: 'develop', title: 'x',
    });
    expect(r).toEqual({ ok: true, data: { iid: 9, url: 'http://x/pulls/9', existed: true } });
    expect(t.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('gitea_get_mr / gitea_get_file / 错误路径', () => {
  it('get_mr 抽取 state/mergeable', async () => {
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('/pulls/42'), respond: () => ({ status: 200, json: { state: 'open', mergeable: true, html_url: 'http://x/42', title: '登录重构' } }) },
    ]);
    const r = await tools(t).get('gitea_get_mr')!.execute({ repo: 'r', mr_iid: 42 });
    expect(r).toMatchObject({ ok: true, data: { state: 'open', mergeable: true, merge_status: 'can_be_merged' } });
  });

  it('get_file base64 解码', async () => {
    const b64c = Buffer.from('export const a = 1', 'utf8').toString('base64');
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('/contents/'), respond: () => ({ status: 200, json: { content: b64c, encoding: 'base64' } }) },
    ]);
    const r = await tools(t).get('gitea_get_file')!.execute({ repo: 'r', branch: 'main', path: 'src/a.ts' });
    expect(r).toEqual({ ok: true, data: { path: 'src/a.ts', content: 'export const a = 1' } });
  });

  it('非 2xx → ok:false 且 error 带 status 与 body', async () => {
    const t = new FakeTransport([
      { match: (m, p) => m === 'GET' && p.includes('/pulls/'), respond: () => ({ status: 404, json: { message: 'Not Found' } }) },
    ]);
    const r = await tools(t).get('gitea_get_mr')!.execute({ repo: 'r', mr_iid: 1 });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('Gitea 404');
    expect((r as { error: string }).error).toContain('Not Found');
  });
});

describe('FetchGiteaTransport', () => {
  it('默认 /api/v1 前缀、Authorization: token 头', async () => {
    let captured: { url: string; headers: HeadersInit | undefined } | undefined;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), headers: init?.headers };
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const t = new FetchGiteaTransport({ baseUrl: 'http://localhost:3000/', token: 'pat-x' });
      await t.request('GET', '/repos/demo/web-app/pulls');
      expect(captured?.url).toBe('http://localhost:3000/api/v1/repos/demo/web-app/pulls');
      expect((captured?.headers as Record<string, string>)?.Authorization).toBe('token pat-x');
    } finally {
      globalThis.fetch = orig;
    }
  });
});
