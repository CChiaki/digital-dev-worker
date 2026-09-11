import type { Tool } from '@ddw/runtime';
import type { GitLabTransport } from './transport.js';
import { enforceCommitMessage } from './commit-message.js';

/** project 标识（数字 id 或 URL-encoded path）→ API path 段 */
function proj(repo: string): string {
  return encodeURIComponent(repo);
}

export interface GitLabDeps {
  transport: GitLabTransport;
  /** 仓库默认值：工具未传 repo 时使用 */
  defaultRepo?: string;
}

function repoOf(deps: GitLabDeps, args: Record<string, unknown>): string {
  const repo = String(args['repo'] ?? deps.defaultRepo ?? '');
  if (!repo) throw new Error('缺少 repo（且未配置 defaultRepo）');
  return repo;
}

function fail(status: number, json: unknown): { ok: false; error: string } {
  return { ok: false, error: `GitLab ${status}: ${JSON.stringify(json)}` };
}

/** GitLab 工具集（API 适配器形态）。
 *  契约：gitlab_create_branch / gitlab_commit_files / gitlab_create_mr / gitlab_get_mr / gitlab_get_file。
 *  幂等语义：建分支已存在=成功；建 MR 已有同源同目标 opened MR=返回已有。 */
export function createGitLabTools(deps: GitLabDeps): Tool[] {
  const { transport } = deps;

  const createBranch: Tool = {
    name: 'gitlab_create_branch',
    description: '在仓库创建工作分支（已存在视为成功）',
    parameters: {
      repo: { type: 'string', description: '仓库标识（project path 或数字 id）', required: false },
      branch: { type: 'string', description: '新分支名', required: true },
      from: { type: 'string', description: '基于哪个分支创建', required: true },
    },
    async execute(args) {
      const repo = repoOf(deps, args);
      const branch = String(args['branch']);
      const from = String(args['from']);
      const exists = await transport.request(
        'GET', `/projects/${proj(repo)}/repository/branches/${encodeURIComponent(branch)}`,
      );
      if (exists.status === 200) {
        return { ok: true, data: { branch, existed: true } };
      }
      const res = await transport.request(
        'POST',
        `/projects/${proj(repo)}/repository/branches?branch=${encodeURIComponent(branch)}&ref=${encodeURIComponent(from)}`,
      );
      if (res.status !== 201 && res.status !== 200) return fail(res.status, res.json);
      return { ok: true, data: { branch, existed: false, url: (res.json as { web_url?: string })?.web_url } };
    },
  };

  const commitFiles: Tool = {
    name: 'gitlab_commit_files',
    description: '在一个 commit 中提交多个文件（自动判断 create/update）；message 首行须为「类型(分支): 摘要」（如 feat(main):），且含「内容点:」段落（逐文件修改说明），「修改文件:」清单自动补全',
    parameters: {
      repo: { type: 'string', description: '仓库标识', required: false },
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
      // 提交规范（2026-09-09，2026-09-10 增分支名）：首行类型(分支)前缀 + 内容点缺失拒绝执行；修改文件清单按实际 files 自动补全
      const enforced = enforceCommitMessage(message, files, branch);
      if (!enforced.ok) return enforced;
      const actions = [];
      for (const f of files) {
        const prev = await transport.request(
          'GET',
          `/projects/${proj(repo)}/repository/files/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(branch)}`,
        );
        actions.push({
          action: prev.status === 200 ? 'update' : 'create',
          file_path: f.path,
          content: f.content,
          encoding: 'text',
        });
      }
      const res = await transport.request('POST', `/projects/${proj(repo)}/repository/commits`, {
        branch,
        commit_message: enforced.message,
        actions,
      });
      if (res.status !== 201 && res.status !== 200) return fail(res.status, res.json);
      const data = res.json as { commit_id?: string; web_url?: string };
      return { ok: true, data: { commit_id: data?.commit_id, files: files.map((f) => f.path) } };
    },
  };

  const createMr: Tool = {
    name: 'gitlab_create_mr',
    description: '创建合并请求（已有同源同目标 opened MR 时返回已有 MR，幂等）',
    parameters: {
      repo: { type: 'string', description: '仓库标识', required: false },
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

      const existing = await transport.request(
        'GET',
        `/projects/${proj(repo)}/merge_requests?source_branch=${encodeURIComponent(source)}&target_branch=${encodeURIComponent(target)}&state=opened`,
      );
      if (existing.status === 200) {
        const list = existing.json as { iid: number; web_url: string }[] | null;
        if (Array.isArray(list) && list.length > 0) {
          return { ok: true, data: { iid: list[0].iid, url: list[0].web_url, existed: true } };
        }
      }
      const res = await transport.request('POST', `/projects/${proj(repo)}/merge_requests`, {
        source_branch: source,
        target_branch: target,
        title,
        description,
      });
      if (res.status !== 201 && res.status !== 200) return fail(res.status, res.json);
      const data = res.json as { iid: number; web_url: string };
      return { ok: true, data: { iid: data.iid, url: data.web_url, existed: false } };
    },
  };

  const getMr: Tool = {
    name: 'gitlab_get_mr',
    description: '查询合并请求状态（state/merge_status/web_url）',
    parameters: {
      repo: { type: 'string', description: '仓库标识', required: false },
      mr_iid: { type: 'number', description: 'MR 的 iid', required: true },
    },
    async execute(args) {
      const repo = repoOf(deps, args);
      const iid = args['mr_iid'];
      const res = await transport.request(
        'GET', `/projects/${proj(repo)}/merge_requests/${encodeURIComponent(String(iid))}`,
      );
      if (res.status !== 200) return fail(res.status, res.json);
      const data = res.json as { state: string; merge_status?: string; web_url: string; title: string };
      return {
        ok: true,
        data: { state: data.state, merge_status: data.merge_status, web_url: data.web_url, title: data.title },
      };
    },
  };

  const getFile: Tool = {
    name: 'gitlab_get_file',
    description: '读取仓库指定分支的文件内容',
    parameters: {
      repo: { type: 'string', description: '仓库标识', required: false },
      branch: { type: 'string', description: '分支/引用', required: true },
      path: { type: 'string', description: '文件路径', required: true },
    },
    async execute(args) {
      const repo = repoOf(deps, args);
      const branch = String(args['branch']);
      const path = String(args['path']);
      const res = await transport.request(
        'GET',
        `/projects/${proj(repo)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
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
