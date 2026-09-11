import type { Tool, ToolParamSpec, ToolResult } from '@ddw/runtime';
import type { CiTransport, BuildStatus } from './transport.js';

const TERMINAL: BuildStatus[] = ['success', 'failed', 'canceled'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const str = (args: Record<string, unknown>, k: string): string | undefined =>
  typeof args[k] === 'string' ? (args[k] as string) : undefined;
const num = (args: Record<string, unknown>, k: string): number | undefined =>
  typeof args[k] === 'number' ? (args[k] as number) : undefined;
const fail = (error: string): ToolResult => ({ ok: false, error });

export interface CiWaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

/** CI 工具集：触发构建 / 查状态 / 等终态（轮询）/ 查日志尾部 */
export function createCiTools(deps: { transport: CiTransport; waitOpts?: CiWaitOptions }): Tool[] {
  const ci = deps.transport;
  const intervalMs = deps.waitOpts?.intervalMs ?? 2_000;
  const timeoutMs = deps.waitOpts?.timeoutMs ?? 10 * 60_000;

  return [
    tool('ci_trigger_build', '对项目分支触发 CI 构建，返回构建 id', {
      project: { type: 'string', description: '项目路径（如 crm/crm-web）', required: true },
      ref: { type: 'string', description: '分支名或 commit', required: true },
    }, async (args) => {
      const project = str(args, 'project');
      const ref = str(args, 'ref');
      if (!project || !ref) return fail('缺少参数 project/ref');
      const { id } = await ci.triggerBuild({ project, ref });
      return { ok: true, data: { id, status: 'created' } };
    }),

    tool('ci_get_build', '查询构建当前状态', {
      id: { type: 'string', description: '构建 id', required: true },
    }, async (args) => {
      const id = str(args, 'id');
      if (!id) return fail('缺少参数 id');
      return { ok: true, data: await ci.getBuild(id) };
    }),

    tool('ci_wait_build', '轮询等待构建到终态（success/failed/canceled），成功才 ok', {
      id: { type: 'string', description: '构建 id', required: true },
    }, async (args) => {
      const id = str(args, 'id');
      if (!id) return fail('缺少参数 id');
      const deadline = Date.now() + timeoutMs;
      let status: BuildStatus = 'created';
      while (Date.now() < deadline) {
        ({ status } = await ci.getBuild(id));
        if (status === 'success') return { ok: true, data: { id, status } };
        if (TERMINAL.includes(status)) return fail(`构建终态为 ${status}，未通过`);
        await sleep(intervalMs);
      }
      return fail(`等待构建超时（>${Math.round(timeoutMs / 1000)}s），最后状态 ${status}`);
    }),

    tool('ci_get_log', '获取构建日志（可 tail 尾部 N 行）', {
      id: { type: 'string', description: '构建 id', required: true },
      tail: { type: 'number', description: '只取最后 N 行' },
    }, async (args) => {
      const id = str(args, 'id');
      if (!id) return fail('缺少参数 id');
      const log = await ci.getLog(id, num(args, 'tail'));
      return { ok: true, data: { log } };
    }),
  ];
}
