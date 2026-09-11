/** Gitea 适配层（2026-09-05）：本地演示环境用户装的是 Gitea（API 与 GitLab v4 不兼容——
 *  前缀 /api/v1、认证头 Authorization: token、路径 /repos/{owner}/{repo}/...、PR 叫 pulls）。
 *  复用 GitLabTransport 接口形状（method/path/body），工具契约语义一致（幂等建分支/建 MR），
 *  工具名走 gitea_* 前缀（员工看到的工具列表与实际服务一致）。
 *  多文件提交优先走 change_files 单 commit（Gitea >= 1.20 企业/定制版）；标准版无此端点
 *  （1.27 实测 404，git/blobs、git/trees 亦无）→ 本地 git CLI 单 commit（clone→commit→push）；
 *  再失败才兜底逐文件 contents API（每文件一条 commit，N 文件 N 条相同 message 提交——实战踩坑）。 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Tool } from '@ddw/runtime';
import type { GitLabTransport, GitLabResponse } from './transport.js';
import { enforceCommitMessage } from './commit-message.js';

export interface FetchGiteaOptions {
  /** Gitea 根地址，如 http://localhost:3000 */
  baseUrl: string;
  /** Personal Access Token（需 write:repository 等 scope） */
  token: string;
  /** API 前缀，默认 /api/v1 */
  apiPrefix?: string;
}

export class FetchGiteaTransport implements GitLabTransport {
  private readonly baseUrl: string;
  private readonly apiPrefix: string;

  constructor(private readonly options: FetchGiteaOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiPrefix = options.apiPrefix ?? '/api/v1';
  }

  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<GitLabResponse> {
    const url = `${this.baseUrl}${this.apiPrefix}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `token ${this.options.token}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }
}

export interface GiteaDeps {
  transport: GitLabTransport;
  /** 仓库默认值：工具未传 repo 时使用（"owner/repo" 形式） */
  defaultRepo?: string;
  /** 本地 git CLI 兜底所需（HTTP API 无法多文件单 commit 时 clone/push 用）；token 仅拼 clone URL，不落日志 */
  localGit?: { baseUrl: string; token: string };
}

function repoOf(deps: GiteaDeps, args: Record<string, unknown>): string {
  const repo = String(args['repo'] ?? deps.defaultRepo ?? '');
  if (!repo) throw new Error('缺少 repo（且未配置 defaultRepo）');
  return repo;
}

/** Gitea 路由按 {owner}/{repo} 分段匹配——不能整体 encode（斜杠会变 %2F 导致 404），逐段编码 */
function rpath(repo: string): string {
  return repo.split('/').map(encodeURIComponent).join('/');
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

const runGit = promisify(execFile);

/** 本地 git CLI 多文件单 commit（HTTP API 不可用时的兜底路径）：临时目录浅 clone → 写文件 →
 *  add/commit（单条 message）→ push。成功返回新 commit sha，任一步失败返回 undefined（由调用方兜底）。
 *  凭证拼在 clone URL 中（仅传给 git 进程，不进错误信息/日志）。 */
export async function commitViaGitCli(
  localGit: { baseUrl: string; token: string },
  repo: string,
  branch: string,
  message: string,
  files: { path: string; content: string; exists?: boolean; sha?: string }[],
): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'ddw-gitea-commit-'));
  try {
    const url = new URL(localGit.baseUrl.replace(/\/$/, ''));
    url.username = 'oauth2';
    url.password = localGit.token;
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${repo}.git`;
    const git = (...args: string[]) => runGit('git', args, { cwd: dir });
    await git('clone', '--depth', '1', '--branch', branch, url.href, '.');
    for (const f of files) {
      const fp = join(dir, f.path);
      await mkdir(dirname(fp), { recursive: true });
      await writeFile(fp, f.content, 'utf8');
    }
    await git('add', '--', ...files.map((f) => f.path));
    try {
      await git('-c', 'user.name=数字员工', '-c', 'user.email=digital-worker@ddw.local', 'commit', '-m', message);
    } catch (e) {
      // 重跑幂等：内容与远端一致（nothing to commit）不算失败，返回当前 HEAD
      const stderr = (e as { stderr?: string }).stderr ?? '';
      if (!stderr.includes('nothing to commit')) throw e;
    }
    const { stdout } = await git('rev-parse', 'HEAD');
    await git('push', 'origin', `HEAD:refs/heads/${branch}`);
    return stdout.trim();
  } catch (e) {
    // git 失败（网络/凭证/分支不存在）→ 交回调用方兜底；错误打服务端日志（token 脱敏）
    const err = e as { message?: string; stderr?: string; stdout?: string };
    const msg = [err.message, err.stderr, err.stdout]
      .filter(Boolean).join(' | ').replaceAll(localGit.token, '***');
    console.error(`[mcp-gitlab] git CLI 单 commit 失败（回退逐文件）: ${msg}`);
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fail(status: number, json: unknown): { ok: false; error: string } {
  return { ok: false, error: `Gitea ${status}: ${JSON.stringify(json)}` };
}

/** Gitea 工具集：gitea_create_branch / gitea_commit_files / gitea_create_mr / gitea_get_mr / gitea_get_file。
 *  幂等语义与 GitLab 版一致：建分支已存在=成功；建 MR 已有同源同目标 open PR=返回已有。 */
export function createGiteaTools(deps: GiteaDeps): Tool[] {
  const { transport } = deps;

  const createBranch: Tool = {
    name: 'gitea_create_branch',
    description: '在仓库创建工作分支（已存在视为成功）',
    parameters: {
      repo: { type: 'string', description: '仓库标识（owner/repo）', required: false },
      branch: { type: 'string', description: '新分支名', required: true },
      from: { type: 'string', description: '基于哪个分支创建', required: true },
    },
    async execute(args) {
      const repo = repoOf(deps, args);
      const branch = String(args['branch']);
      const from = String(args['from']);
      const exists = await transport.request(
        'GET', `/repos/${rpath(repo)}/branches/${encodeURIComponent(branch)}`,
      );
      if (exists.status === 200) {
        return { ok: true, data: { branch, existed: true } };
      }
      const res = await transport.request('POST', `/repos/${rpath(repo)}/branches`, {
        new_branch_name: branch,
        old_branch_name: from, // 1.12 起兼容（新版本改叫 old_ref_name，此名仍被接受）
      });
      if (res.status !== 201 && res.status !== 200) return fail(res.status, res.json);
      return { ok: true, data: { branch, existed: false } };
    },
  };

  const commitFiles: Tool = {
    name: 'gitea_commit_files',
    description: '提交多个文件（Gitea >= 1.20 单 commit；旧版自动逐文件提交）；message 首行须为「类型(分支): 摘要」（如 feat(main):），且含「内容点:」段落（逐文件修改说明），「修改文件:」清单自动补全',
    parameters: {
      repo: { type: 'string', description: '仓库标识（owner/repo）', required: false },
      branch: { type: 'string', description: '目标分支', required: true },
      files: { type: 'array', description: '文件列表 [{path, content}]', required: true },
      message: {
        type: 'string',
        description: '提交说明：首行「类型(分支): 摘要」（类型 feat/fix/docs/…，分支与 branch 参数一致）+ 「内容点:」段落（每文件一行「- 路径: 改动说明」）；格式不符或缺「内容点:」会被拒绝',
        required: true,
      },
    },
    async execute(args) {
      const repo = repoOf(deps, args);
      const branch = String(args['branch']);
      const message = String(args['message']);
      const files = args['files'] as { path: string; content: string }[];
      if (!Array.isArray(files) || files.length === 0) {
        return { ok: false, error: 'files 不能为空' };
      }
      // 提交规范（2026-09-09，2026-09-10 增分支名）：首行类型(分支)前缀 + 内容点缺失拒绝执行；修改文件清单按实际 files 自动补全（三条提交路径共用）
      const enforced = enforceCommitMessage(message, files, branch);
      if (!enforced.ok) return enforced;
      // 先探测存在性（change_files 的 update 带上 sha 更稳）
      const probed = [];
      for (const f of files) {
        const prev = await transport.request(
          'GET',
          `/repos/${rpath(repo)}/contents/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(branch)}`,
        );
        probed.push({
          path: f.path,
          content: f.content,
          exists: prev.status === 200,
          ...(prev.status === 200 ? { sha: (prev.json as { sha?: string })?.sha } : {}),
        });
      }
      const base = `/repos/${rpath(repo)}`;
      const changeBody = {
        files: probed.map((f) => ({
          operation: f.exists ? 'update' : 'create',
          path: f.path,
          contents: b64(f.content),
          ...(f.exists && f.sha ? { sha: f.sha } : {}),
        })),
        branch,
        message: enforced.message,
      };
      const res = await transport.request('POST', `${base}/change_files`, changeBody);
      if (res.status === 200 || res.status === 201) {
        const sha = (res.json as { sha?: string } | null)?.sha;
        return { ok: true, data: { ...(sha ? { commit_id: sha } : {}), files: files.map((f) => f.path) } };
      }
      // change_files 不可用（标准 Gitea 无此端点，如 1.27 实测 404）→ 本地 git CLI 单 commit：
      // 不能走逐文件 contents API——每文件一条 commit，N 个文件产生 N 条相同 message 提交（实战踩坑）。
      const cliSha = deps.localGit
        ? await commitViaGitCli(deps.localGit, repo, branch, enforced.message, probed)
        : undefined;
      if (cliSha) {
        return { ok: true, data: { commit_id: cliSha, files: files.map((f) => f.path), mode: 'git-cli' } };
      }
      // git CLI 也不可用（未配置 localGit / 失败）→ 最终兜底逐文件 contents API（每文件一个 commit，message 相同）
      for (const f of probed) {
        const fp = `${base}/contents/${encodeURIComponent(f.path)}`;
        const body = { content: b64(f.content), message: enforced.message, branch, ...(f.exists && f.sha ? { sha: f.sha } : {}) };
        const r = await transport.request(f.exists ? 'PUT' : 'POST', fp, body);
        if (r.status !== 200 && r.status !== 201) return fail(r.status, r.json);
      }
      return { ok: true, data: { files: files.map((f) => f.path), mode: 'per-file' } };
    },
  };

  const createMr: Tool = {
    name: 'gitea_create_mr',
    description: '创建合并请求（已有同源同目标 open PR 时返回已有 PR，幂等）',
    parameters: {
      repo: { type: 'string', description: '仓库标识（owner/repo）', required: false },
      source: { type: 'string', description: '源分支', required: true },
      target: { type: 'string', description: '目标分支', required: true },
      title: { type: 'string', description: 'MR 标题', required: true },
      description: { type: 'string', description: 'MR 描述（改动清单/验收情况）', required: false },
    },
    async execute(args) {
      const repo = repoOf(deps, args);
      const source = String(args['source']);
      const target = String(args['target']);
      const title = String(args['title']);
      const description = args['description'] ? String(args['description']) : '';

      // Gitea 无 source/target 查询参数，拉 open 列表后本地过滤
      const existing = await transport.request(
        'GET', `/repos/${rpath(repo)}/pulls?state=open&limit=50`,
      );
      if (existing.status === 200) {
        const list = existing.json as { number: number; html_url: string; head?: { ref?: string }; base?: { ref?: string } }[] | null;
        const hit = Array.isArray(list)
          ? list.find((p) => p.head?.ref === source && p.base?.ref === target)
          : undefined;
        if (hit) {
          return { ok: true, data: { iid: hit.number, url: hit.html_url, existed: true } };
        }
      }
      const res = await transport.request('POST', `/repos/${rpath(repo)}/pulls`, {
        head: source,
        base: target,
        title,
        body: description,
      });
      if (res.status !== 201 && res.status !== 200) return fail(res.status, res.json);
      const data = res.json as { number: number; html_url: string };
      return { ok: true, data: { iid: data.number, url: data.html_url, existed: false } };
    },
  };

  const getMr: Tool = {
    name: 'gitea_get_mr',
    description: '查询合并请求状态（state/mergeable/web_url）',
    parameters: {
      repo: { type: 'string', description: '仓库标识（owner/repo）', required: false },
      mr_iid: { type: 'number', description: 'PR 编号（number/index）', required: true },
    },
    async execute(args) {
      const repo = repoOf(deps, args);
      const iid = args['mr_iid'];
      const res = await transport.request(
        'GET', `/repos/${rpath(repo)}/pulls/${encodeURIComponent(String(iid))}`,
      );
      if (res.status !== 200) return fail(res.status, res.json);
      const data = res.json as { state: string; mergeable?: boolean; html_url: string; title: string };
      return {
        ok: true,
        data: {
          state: data.state,
          mergeable: data.mergeable,
          merge_status: data.mergeable === true ? 'can_be_merged' : undefined,
          web_url: data.html_url,
          title: data.title,
        },
      };
    },
  };

  const getFile: Tool = {
    name: 'gitea_get_file',
    description: '读取仓库指定分支的文件内容',
    parameters: {
      repo: { type: 'string', description: '仓库标识（owner/repo）', required: false },
      branch: { type: 'string', description: '分支/引用', required: true },
      path: { type: 'string', description: '文件路径', required: true },
    },
    async execute(args) {
      const repo = repoOf(deps, args);
      const branch = String(args['branch']);
      const path = String(args['path']);
      const res = await transport.request(
        'GET',
        `/repos/${rpath(repo)}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
      );
      if (res.status !== 200) return fail(res.status, res.json);
      const data = res.json as { content: string; encoding: string };
      const content =
        data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString('utf8') : data.content;
      return { ok: true, data: { path, content } };
    },
  };

  return [createBranch, commitFiles, createMr, getMr, getFile];
}
