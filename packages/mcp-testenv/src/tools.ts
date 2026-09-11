import type { Tool, ToolParamSpec, ToolResult } from '@ddw/runtime';
import type { TestenvTransport } from './transport.js';

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

/** 验证环境工具集：健康检查 + 轻量取页（深度走查用 browser-mcp） */
export function createTestenvTools(deps: { transport: TestenvTransport }): Tool[] {
  const t = deps.transport;
  return [
    tool('testenv_check_health', '验证环境健康检查：HTTP 200 且（可选）包含关键文案才算健康', {
      url: { type: 'string', description: '健康检查地址（如 http://testenv.local/crm/health）', required: true },
      contains: { type: 'string', description: '响应体必须包含的文案（如版本号/UP）' },
    }, async (args) => {
      const url = str(args, 'url');
      if (!url) return fail('缺少参数 url');
      const { status, body } = await t.check(url);
      if (status !== 200) return fail(`健康检查失败：HTTP ${status}`);
      const contains = str(args, 'contains');
      if (contains && !body.includes(contains)) {
        return fail(`健康检查未包含关键文案 "${contains}"，响应体: ${body.slice(0, 200)}`);
      }
      return { ok: true, data: { status, healthy: true } };
    }),

    tool('testenv_get_page', '取验证环境页面原始内容（轻量验证；深度走查请用 browser_* 工具）', {
      url: { type: 'string', description: '页面地址', required: true },
    }, async (args) => {
      const url = str(args, 'url');
      if (!url) return fail('缺少参数 url');
      return { ok: true, data: await t.check(url) };
    }),
  ];
}
