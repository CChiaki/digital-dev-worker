import { LocalWorkspace, ToolRegistry, createWorkspaceTools, createBashTool, ControlledBash, NoopBackend, BwrapBackend, DockerBackend, type SandboxBackend, type Tool } from '@ddw/runtime';
import { createGitLabTools, FetchGitLabTransport, createGiteaTools, FetchGiteaTransport } from '@ddw/mcp-gitlab';
import { createDeployTools, createArtifactTransport } from '@ddw/mcp-deploy';
import type { ForgeConfig, DeployConfig } from './runtime-config.js';
import type { McpToolSource } from './mcp-hub.js';

/** bash 硬防线 backend 类型字面量（可序列化——fork worker 的 IPC 消息只能带 JSON） */
export type BackendKind = 'noop' | 'bwrap' | 'docker';

/** 由类型字面量构造 backend 实例（bwrap/docker 选项二期按部署机配置扩展） */
export function makeBackend(kind: BackendKind = 'noop', workspaceDir?: string): SandboxBackend {
  if (kind === 'bwrap') return new BwrapBackend({ workspace: workspaceDir ?? '/workspace' });
  if (kind === 'docker') return new DockerBackend({ container: 'ddw-agent' });
  return new NoopBackend();
}

/** 任务包 repo.url → GitLab project path（"http://host/demo/x.git" → "demo/x"，作为工具 defaultRepo） */
export function repoPathFromUrl(url: string): string {
  const clean = url.replace(/\.git$/, '');
  const idx = clean.indexOf('://');
  const rest = idx >= 0 ? clean.slice(idx + 3) : clean;
  const slash = rest.indexOf('/');
  return slash >= 0 ? rest.slice(slash + 1) : rest;
}

/** 生产缺省工具集（builtin/mcp 分档）：builtin 内置档 = 工作区编码工具 + 受控 bash（白名单 +
 *  硬防线 backend 实例注入），mcp 工具包档 = forge 代码托管协作（forge 段配置时按 provider
 *  注入 GitLab/Gitea 工具集，defaultRepo 由任务包 repo.url 推导）与 deploy 产物发布工具。
 *  不传 builtin/mcp 时行为与分档前一致（bash+files 恒注册、forge 按配置注册、deploy 不注册）。 */
export function defaultToolsFor(
  wsDir: string,
  opts: {
    bashWhitelist?: string[]; backend?: SandboxBackend; forge?: ForgeConfig; defaultRepo?: string;
    /** 受控 bash 单条命令超时毫秒（缺省 60s）：构建类命令按需放大 */
    bashTimeoutMs?: number;
    /** 发布部署配置（mcp 含 'deploy' 时须传） */
    deploy?: DeployConfig;
    /** 内置能力分档（缺省 ['bash','files'] = 现状）；mcp 工具包分档（缺省 ['forge'] = 现状） */
    builtin?: string[]; mcp?: string[];
    /** 标准 MCP 工具源（2026-09-06 用户需求 B）：mcp 分档中非内置包标识（forge/deploy）的
     *  名字按 MCP server 名从此处取已发现工具；缺省 undefined 时这些名字解析为空 */
    mcpHub?: McpToolSource;
    /** 白名单外命令人工审批回调（2026-09-10）：由调用方绑定 gate/事件构造（makeBashApproval）；
     *  缺省不注入 = 命中白名单硬拒零回归 */
    bashApproval?: (cmd: string) => Promise<{ approved: boolean; comment?: string }>;
    /** 信任期放权（2026-09-11 盯梢三级重构）：true = trusted 级员工跳过白名单直接执行；
     *  黑名单/组合命令/超时仍拦。与 bashApproval 互斥（bypass 时审批不可达） */
    bypassWhitelist?: boolean;
  } = {},
): ToolRegistry {
  const builtin = opts.builtin ?? ['bash', 'files'];
  const mcp = opts.mcp ?? ['forge'];
  const tools = new ToolRegistry();
  if (builtin.includes('files')) {
    for (const t of createWorkspaceTools(new LocalWorkspace(wsDir))) {
      tools.register(t);
    }
  }
  if (builtin.includes('bash')) {
    tools.register(createBashTool(new ControlledBash({
      root: wsDir,
      whitelist: opts.bashWhitelist ?? ['git', 'node', 'npm', 'npx', 'python3'],
      ...(opts.bashTimeoutMs !== undefined ? { timeoutMs: opts.bashTimeoutMs } : {}),
      ...(opts.backend ? { backend: opts.backend } : {}),
      ...(opts.bashApproval ? { approval: opts.bashApproval } : {}),
      ...(opts.bypassWhitelist ? { bypassWhitelist: true } : {}),
    })));
  }
  if (mcp.includes('forge') && opts.forge) {
    // 构造时不发请求（transport 只在工具 execute 时访问网络）
    const { provider, baseUrl, token } = opts.forge;
    const repoTools =
      provider === 'gitea'
        ? createGiteaTools({
            transport: new FetchGiteaTransport({ baseUrl, token }),
            // 本地 git CLI 兜底（HTTP API 无法多文件单 commit 时 clone/push 用）
            localGit: { baseUrl, token },
            ...(opts.defaultRepo ? { defaultRepo: opts.defaultRepo } : {}),
          })
        : createGitLabTools({
            transport: new FetchGitLabTransport({ baseUrl, token }),
            ...(opts.defaultRepo ? { defaultRepo: opts.defaultRepo } : {}),
          });
    for (const t of repoTools) {
      tools.register(t);
    }
  }
  // deploy 工具注册条件 = mcp 含 'deploy' 且传了 deploy 配置；缺一则不注册（fail fast 在任务执行器）
  if (mcp.includes('deploy') && opts.deploy) {
    const transport = createArtifactTransport({ envs: opts.deploy.envs, workspaceDir: wsDir });
    // 环境白名单来自运行时 deploy.envs 配置（自定义环境名如 web 可部署；生产类环境不进配置即不可达）
    for (const t of createDeployTools({ transport, allowedEnvs: opts.deploy.envs.map((e) => e.name) })) tools.register(t);
  }
  // 标准 MCP server 工具（2026-09-06 用户需求 B）：mcp 分档中非内置包标识的名字 = MCP server 名
  const mcpServerNames = mcp.filter((n) => n !== 'forge' && n !== 'deploy');
  if (opts.mcpHub && mcpServerNames.length > 0) {
    for (const t of opts.mcpHub.toolsFor(mcpServerNames)) {
      tools.register(t);
    }
  }
  return tools;
}

/** defaultToolsFor 的 mcpHub 参数最小契约复导出（装配方避免直接依赖 mcp-hub 实现细节） */
export type { McpToolSource };
