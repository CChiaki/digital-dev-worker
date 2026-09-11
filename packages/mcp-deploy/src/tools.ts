import type { Tool, ToolParamSpec, ToolResult } from '@ddw/runtime';
import type { DeployTransport, DeployEnv, DeployStatus } from './transport.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (error: string): ToolResult => ({ ok: false, error });
const str = (args: Record<string, unknown>, k: string): string | undefined =>
  typeof args[k] === 'string' ? (args[k] as string) : undefined;

function tool(name: string, description: string, params: ToolParamSpec, run: (args: Record<string, unknown>) => Promise<ToolResult>): Tool {
  return {
    name, description, parameters: params,
    async execute(args) {
      try {
        return await run(args);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

export interface DeployWaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

const DONE: DeployStatus = 'done';

/** 部署工具集：发起部署 / 等待完成。盯梢期调用方须为导师授权的任务。 */
export function createDeployTools(deps: {
  transport: DeployTransport;
  waitOpts?: DeployWaitOptions;
  /** 可部署环境白名单（由运行时 deploy.envs 配置注入；缺省 test/staging） */
  allowedEnvs?: string[];
}): Tool[] {
  const d = deps.transport;
  const intervalMs = deps.waitOpts?.intervalMs ?? 2_000;
  const timeoutMs = deps.waitOpts?.timeoutMs ?? 5 * 60_000;
  const allowed = deps.allowedEnvs ?? ['test', 'staging'];

  return [
    tool('deploy_to_env', `将项目指定版本部署到环境（仅 ${allowed.join(' | ')}；生产环境不在数字员工权限内）`, {
      project: { type: 'string', description: '项目路径', required: true },
      env: { type: 'string', description: `目标环境：${allowed.join(' | ')}`, required: true },
      version: { type: 'string', description: '部署版本（commit/镜像 tag）', required: true },
    }, async (args) => {
      const project = str(args, 'project');
      const env = str(args, 'env');
      const version = str(args, 'version');
      if (!project || !env || !version) return fail('缺少参数 project/env/version');
      if (!allowed.includes(env)) {
        return fail(`非法环境 "${env}"：数字员工仅可部署 ${allowed.join('/')}，生产环境须人工操作`);
      }
      return { ok: true, data: await d.deploy({ project, env: env as DeployEnv, version }) };
    }),

    tool('deploy_wait', '轮询等待部署完成（done 才 ok）', {
      id: { type: 'string', description: '部署单 id', required: true },
    }, async (args) => {
      const id = str(args, 'id');
      if (!id) return fail('缺少参数 id');
      const deadline = Date.now() + timeoutMs;
      let status: DeployStatus = 'pending';
      while (Date.now() < deadline) {
        ({ status } = await d.getDeploy(id));
        if (status === DONE) return { ok: true, data: { id, status } };
        if (status === 'failed') return fail(`部署失败（status=failed）`);
        await sleep(intervalMs);
      }
      return fail(`等待部署超时（>${Math.round(timeoutMs / 1000)}s），最后状态 ${status}`);
    }),
  ];
}
