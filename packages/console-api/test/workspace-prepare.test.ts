import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { injectForgeToken, prepareTaskWorkspace, assertRepoReachable } from '../src/team/workspace-prepare.js';

const sh = promisify(execFile);

let root: string;
let srcRepo: string; // clone 源仓库 fixture
let wsDir: string;   // 任务工作区（空目录，executor mkdir 后的形态）

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-wsprep-'));
  srcRepo = join(root, 'src-repo');
  await mkdir(srcRepo, { recursive: true });
  await sh('git', ['init', '-q', '-b', 'main', srcRepo]);
  await sh('git', ['-C', srcRepo, 'config', 'user.email', 't@t']);
  await sh('git', ['-C', srcRepo, 'config', 'user.name', 't']);
  await writeFile(join(srcRepo, 'README.md'), 'hello', 'utf8');
  await sh('git', ['-C', srcRepo, 'add', '-A']);
  await sh('git', ['-C', srcRepo, 'commit', '-q', '-m', 'init']);
  wsDir = join(root, 'ws-empty');
  await mkdir(wsDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const taskOf = (url: string, branch?: string) =>
  ({ taskId: 'T', repo: { url, ...(branch ? { branch } : {}) } } as never);

describe('injectForgeToken（纯函数）', () => {
  it('配置 forge → http(s) url 注入 oauth2:token；未配置/非 http 原样', () => {
    const forge = { provider: 'gitea' as const, baseUrl: 'http://localhost:3000', token: 'tk-123' };
    expect(injectForgeToken('http://localhost:3000/admin/dome.git', forge))
      .toBe('http://oauth2:tk-123@localhost:3000/admin/dome.git');
    expect(injectForgeToken('https://g.example.com/a/b.git', forge))
      .toBe('https://oauth2:tk-123@g.example.com/a/b.git');
    expect(injectForgeToken('http://localhost:3000/admin/dome.git')).toBe('http://localhost:3000/admin/dome.git');
    expect(injectForgeToken('/local/path/repo.git', forge)).toBe('/local/path/repo.git');
  });
});

describe('prepareTaskWorkspace（执行前 clone，2026-09-06 实战修复）', () => {
  it('空目录 → clone 成功（.git 在位、文件落地）', async () => {
    await prepareTaskWorkspace(wsDir, taskOf(srcRepo));
    expect((await readdir(wsDir)).join(',')).toContain('.git');
    const log = await sh('git', ['-C', wsDir, 'log', '--oneline']);
    expect(log.stdout).toContain('init');
  });

  it('repo.branch remote 无同名分支 → 基于 HEAD 本地新建；remote 有 → 跟踪检出', async () => {
    await prepareTaskWorkspace(wsDir, taskOf(srcRepo, 'dev'));
    expect((await sh('git', ['-C', wsDir, 'branch', '--show-current'])).stdout.trim()).toBe('dev');

    // remote 有 feature 分支：先建到源仓库
    await sh('git', ['-C', srcRepo, 'checkout', '-q', '-b', 'feature']);
    await sh('git', ['-C', srcRepo, 'commit', '-q', '--allow-empty', '-m', 'feat']);
    await rm(wsDir, { recursive: true, force: true });
    await mkdir(wsDir, { recursive: true });
    await prepareTaskWorkspace(wsDir, taskOf(srcRepo, 'feature'));
    expect((await sh('git', ['-C', wsDir, 'branch', '--show-current'])).stdout.trim()).toBe('feature');
  });

  it('非空目录 = 断点续跑现场 → 跳过 clone 不覆盖', async () => {
    await writeFile(join(wsDir, 'artifact.txt'), '产物', 'utf8');
    await prepareTaskWorkspace(wsDir, taskOf(srcRepo));
    expect((await readdir(wsDir)).join(',')).not.toContain('.git'); // 没 clone
    expect((await readdir(wsDir)).join(',')).toContain('artifact.txt'); // 产物还在
  });

  it('仓库不可达 → 报错带原始 url（不再静默留空目录）', async () => {
    const bad = join(root, 'no-such-repo.git');
    await expect(prepareTaskWorkspace(wsDir, taskOf(bad))).rejects.toThrow(`任务仓库 clone 失败（${bad}）`);
  });
});

describe('assertRepoReachable（发布前校验，2026-09-06 实战修复）', () => {
  it('可达仓库通过（不抛）', async () => {
    await expect(assertRepoReachable(srcRepo)).resolves.toBeUndefined();
  });

  it('不可达/占位符仓库 → 报错带 url（test-task-package 教训：发布时拦截）', async () => {
    await expect(assertRepoReachable(join(root, 'CHANGE-ME.git'))).rejects.toThrow('仓库不可达');
  });
});

// ---- 发布时自动建仓（2026-09-06 用户需求）：not found → 创建 → 复核 ----
import { vi } from 'vitest';
import { parseRepoPath, createRepo, ensureRepoReachable } from '../src/team/workspace-prepare.js';
import type { ForgeConfig } from '../src/team/runtime-config.js';

const gitea = (over: Partial<ForgeConfig> = {}): ForgeConfig =>
  ({ provider: 'gitea', baseUrl: 'http://gitea.test', token: 'tk-1', ...over });

describe('parseRepoPath（url → owner/name）', () => {
  it('合法 url 解析 owner/name（.git 后缀与尾斜杠容错）', () => {
    expect(parseRepoPath('http://gitea.test/admin/dome.git')).toEqual({ owner: 'admin', name: 'dome' });
    expect(parseRepoPath('http://gitea.test/admin/dome')).toEqual({ owner: 'admin', name: 'dome' });
    expect(parseRepoPath('http://gitea.test/admin/dome.git/')).toEqual({ owner: 'admin', name: 'dome' });
  });

  it('缺 owner/仓库名（只有域名）→ 可读报错（digital-employee-detail-site 的 url 教训）', () => {
    expect(() => parseRepoPath('http://localhost:3000/')).toThrow('缺少 owner/仓库名');
    expect(() => parseRepoPath('not-a-url')).toThrow('不是合法地址');
  });
});

describe('createRepo（Gitea 自动建仓）', () => {
  it('owner 是组织 → 建组织仓库（auto_init: false，空仓库不污染历史）', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({ full_name: 'myorg' }) })   // GET orgs/myorg
      .mockResolvedValueOnce({ status: 201, json: async () => ({ full_name: 'myorg/new-repo' }) }); // POST
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(createRepo('http://gitea.test/myorg/new-repo.git', gitea())).resolves.toBeUndefined();
      const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
      expect(url).toBe('http://gitea.test/api/v1/orgs/myorg/repos');
      expect(JSON.parse(init.body as string)).toMatchObject({ name: 'new-repo', auto_init: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('owner 是 token 属主 → 建个人仓库', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 404, json: async () => ({ message: 'not found' }) }) // GET orgs/admin
      .mockResolvedValueOnce({ status: 200, json: async () => ({ login: 'admin' }) })       // GET user
      .mockResolvedValueOnce({ status: 201, json: async () => ({}) });                      // POST /user/repos
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(createRepo('http://gitea.test/admin/new-repo.git', gitea())).resolves.toBeUndefined();
      expect(fetchMock.mock.calls[2]![0]).toBe('http://gitea.test/api/v1/user/repos');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('owner 既非组织也非 token 属主 → 不越权创建，可读报错', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ login: 'admin' }) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(createRepo('http://gitea.test/other/repo.git', gitea())).rejects.toThrow('也不是 token 属主');
      expect(fetchMock).toHaveBeenCalledTimes(2); // 没发 POST
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Gitea 创建接口报错 → 带响应 message 上抛', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({}) })
      .mockResolvedValueOnce({ status: 422, json: async () => ({ message: 'already exists' }) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(createRepo('http://gitea.test/myorg/dup.git', gitea())).rejects.toThrow('already exists');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('ensureRepoReachable（发布校验 + 可选自动建仓）', () => {
  it('未开 autoCreateRepo → not found 也原样拦截，不触碰建仓 API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(ensureRepoReachable(join(root, 'CHANGE-ME.git'), gitea())).rejects.toThrow('仓库不可达');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('开开关 + not found 类失败 → 建仓 API 被调用，建后复核失败如实拦截', async () => {
    // file url 指向不存在路径 → ls-remote 报 "does not appear..."（not found 类）；
    // mock 建仓成功后复核仍失败（该路径不会凭空变出仓库），验证全控制流
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({ full_name: 'no-such' }) })  // GET orgs
      .mockResolvedValueOnce({ status: 201, json: async () => ({}) });                       // POST 建仓
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(ensureRepoReachable('file:///no-such/repo.git', gitea({ autoCreateRepo: true })))
        .rejects.toThrow('仓库不可达'); // 复核拦截（createRepo 成功但仓库仍不可达）
      expect(fetchMock).toHaveBeenCalledTimes(2); // 建仓确实发生了
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('开开关 + 网络类失败（非 not found）→ 不误建，原样拦截', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(ensureRepoReachable('http://localhost:1/no-such/repo.git', gitea({ autoCreateRepo: true })))
        .rejects.toThrow('仓库不可达');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
