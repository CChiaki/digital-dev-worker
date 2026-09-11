import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskPackage } from '@ddw/runtime';
import type { ForgeConfig } from './runtime-config.js';

/**
 * 任务工作区准备（2026-09-06 实战修复）：生产链路此前从不 clone，员工拿到空目录后
 * git 命令穿透到上层仓库（分支/提交全错）——digital-employee-detail-page 停在第 1 项的根因。
 * 现执行前按任务包 repo.url clone 代码 + 检出工作分支；clone 失败直接报错留痕，
 * 不再静默留空目录。续跑（dir 已有产物）幂等跳过，不破坏断点现场。
 */

/** repo.url 注入 forge 认证（纯函数可测）：http(s) + 配置了 forge 时用 oauth2:token 形式 */
export function injectForgeToken(url: string, forge?: ForgeConfig): string {
  if (!forge) return url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return url;
  const u = new URL(url);
  u.username = 'oauth2';
  u.password = forge.token;
  return u.toString();
}

/** git 命令包装：非零退出/超时 → 带首行 stderr 的可读错误（模型与人工都能看懂）；
 *  cwd 必须显式指定（缺省进程 cwd 会误操作主项目仓库） */
function git(args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      const first = stderr.split('\n').find((l) => l.trim()) ?? err.message;
      reject(new Error(`git ${args[0]} 失败：${first.trim()}`));
    });
  });
}

/**
 * clone 任务仓库到工作区（dir 需已存在且为空——executor mkdir 后调用）；
 * 非空目录 = 断点续跑现场，跳过 clone 保住产物。检出 task.repo.branch（remote 有 → 跟踪；
 * 无 → 基于 HEAD 本地新建，覆盖「切 dev 分支」类计划项的起点）。
 */
export async function prepareTaskWorkspace(dir: string, task: TaskPackage, forge?: ForgeConfig): Promise<void> {
  const existing = await readdir(dir).catch(() => [] as string[]);
  if (existing.length > 0) return; // 续跑/预置现场：不覆盖
  const url = injectForgeToken(task.repo.url, forge);
  try {
    await git(['clone', url, dir], dirname(dir), 120_000);
  } catch (e) {
    throw new Error(`任务仓库 clone 失败（${task.repo.url}）：${e instanceof Error ? e.message : String(e)}`);
  }
  const branch = task.repo.branch;
  if (branch) {
    // remote 有同名分支 → 跟踪检出；没有 → 本地新建（不吞错，检出失败即停）
    await git(['checkout', '-B', branch, `origin/${branch}`], dir, 30_000).catch(() =>
      git(['checkout', '-B', branch], dir, 30_000));
  }
}

/**
 * 发布前仓库可达性校验（2026-09-06 实战修复）：repo 为占位符/不可达的任务在发布时拦截
 * （test-task-package 停在第 2 项的教训——带病进调度到提交步才 404）。ls-remote 轻量探测。
 */
export async function assertRepoReachable(url: string, forge?: ForgeConfig, timeoutMs = 15_000): Promise<void> {
  try {
    await git(['ls-remote', injectForgeToken(url, forge), 'HEAD'], tmpdir(), timeoutMs);
  } catch (e) {
    throw new Error(`仓库不可达（${url}）：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 分派执行前 clone 用的闭包（pipeline inproc 装配注入 prepareWorkspace 钩子） */
export function clonePrepare(forge?: ForgeConfig): (dir: string, task: TaskPackage) => Promise<void> {
  return (dir, task) => prepareTaskWorkspace(dir, task, forge);
}

// ---- 发布时自动建仓（2026-09-06 用户需求）：repo.url 指向尚不存在的仓库，发布即创建 ----
// 前提约束：clone 是任务执行第一步，员工自己建仓来不及——建仓只能发生在发布环节。

/** 解析 repo.url 的 owner/name（http(s)://host/owner/name[.git]）；格式不完整抛可读错误 */
export function parseRepoPath(url: string): { owner: string; name: string } {
  let path: string;
  try {
    path = new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    throw new Error(`repo.url 不是合法地址：${url}`);
  }
  const segs = path.split('/').filter(Boolean);
  if (segs.length !== 2) {
    throw new Error(`repo.url 缺少 owner/仓库名（应为 http://host/owner/repo.git 形式）：${url}`);
  }
  return { owner: segs[0]!, name: segs[1]!.replace(/\.git$/, '') };
}

/** forge REST 请求（Gitea /api/v1）：非 2xx 由调用方按 status 分支处理 */
async function forgeApi(forge: ForgeConfig, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${forge.baseUrl}/api/v1${path}`, {
    method,
    headers: { authorization: `token ${forge.token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** 自动建仓（仅 Gitea）：owner 是组织 → 建组织仓库；owner 是 token 属主 → 建个人仓库；
 *  其余命名空间（他人名下）不越权创建，报可读错误。空仓库（auto_init: false）——
 *  clone 空仓库 exit 0，检出走「本地新建分支」回退，不带 Initial commit 污染历史 */
export async function createRepo(url: string, forge: ForgeConfig): Promise<void> {
  if (forge.provider !== 'gitea') {
    throw new Error(`自动建仓暂仅支持 gitea（当前 provider: ${forge.provider}）`);
  }
  const { owner, name } = parseRepoPath(url);
  const org = await forgeApi(forge, 'GET', `/orgs/${owner}`);
  let apiPath = `/orgs/${owner}/repos`;
  if (org.status !== 200) {
    const me = await forgeApi(forge, 'GET', '/user');
    const login = (me.json as { login?: string }).login;
    if (me.status !== 200 || login !== owner) {
      throw new Error(`无法自动创建仓库：owner "${owner}" 既不是 forge 上的组织也不是 token 属主（${login ?? '未知'}）`);
    }
    apiPath = '/user/repos';
  }
  const created = await forgeApi(forge, 'POST', apiPath, { name, private: false, auto_init: false });
  if (created.status >= 300) {
    const msg = (created.json as { message?: string }).message ?? JSON.stringify(created.json);
    throw new Error(`自动创建仓库失败（${owner}/${name}）：${msg}`);
  }
}

/**
 * 发布前仓库校验（含可选自动建仓）：默认等同 assertRepoReachable；开启 forge.autoCreateRepo
 * 后，仓库不存在（not found）类失败 → 自动创建 → 复核放行。网络故障/权限问题/非法 url
 * 不误建，原样拦截（不带病进调度）。
 */
export async function ensureRepoReachable(url: string, forge?: ForgeConfig, timeoutMs = 15_000): Promise<void> {
  try {
    await assertRepoReachable(url, forge, timeoutMs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const notFound = /not found|does not exist|does not appear/i.test(msg);
    if (!forge?.autoCreateRepo || !notFound) throw e;
    await createRepo(url, forge);
    await assertRepoReachable(url, forge, timeoutMs);
  }
}
