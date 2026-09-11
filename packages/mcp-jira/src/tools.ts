import type { Tool } from '@ddw/runtime';
import type { JiraTransport } from './transport.js';

function fail(status: number, json: unknown): { ok: false; error: string } {
  return { ok: false, error: `Jira ${status}: ${JSON.stringify(json)}` };
}

/** Jira 工具集（API 适配器形态，impl: 'api'）。
 *  契约：jira_get_issue / jira_update_status / jira_add_comment；
 *  同契约 ui 实现（Playwright 垫片）见 ui-adapter.ts——按系统有无 API 注入互换。 */
export function createJiraTools(deps: { transport: JiraTransport }): Tool[] {
  const { transport } = deps;

  const getIssue: Tool = {
    name: 'jira_get_issue',
    impl: 'api',
    description: '查询 Jira 单（summary/状态/描述）',
    parameters: {
      key: { type: 'string', description: 'Jira 单号，如 TASK-123', required: true },
    },
    async execute(args) {
      const key = String(args['key']);
      const res = await transport.request('GET', `/issue/${encodeURIComponent(key)}`);
      if (res.status !== 200) return fail(res.status, res.json);
      const data = res.json as {
        key: string;
        fields: { summary: string; status: { name: string }; description?: string };
      };
      return {
        ok: true,
        data: {
          key: data.key,
          summary: data.fields.summary,
          status: data.fields.status.name,
          description: data.fields.description ?? '',
        },
      };
    },
  };

  const updateStatus: Tool = {
    name: 'jira_update_status',
    impl: 'api',
    description: '流转 Jira 单状态（自动查找目标状态对应的 transition）',
    parameters: {
      key: { type: 'string', description: 'Jira 单号', required: true },
      status: { type: 'string', description: '目标状态名（如 开发中/待测试）', required: true },
    },
    async execute(args) {
      const key = String(args['key']);
      const status = String(args['status']);
      const tr = await transport.request('GET', `/issue/${encodeURIComponent(key)}/transitions`);
      if (tr.status !== 200) return fail(tr.status, tr.json);
      const transitions = (tr.json as { transitions: { id: string; name: string; to: { name: string } }[] }).transitions ?? [];
      const hit = transitions.find(
        (t) => t.name === status || t.to.name === status,
      );
      if (!hit) {
        return {
          ok: false,
          error: `Jira 单 ${key} 没有到「${status}」的流转，可用: ${transitions.map((t) => t.to.name).join(', ')}`,
        };
      }
      const res = await transport.request('POST', `/issue/${encodeURIComponent(key)}/transitions`, {
        transition: { id: hit.id },
      });
      if (res.status !== 204 && res.status !== 200) return fail(res.status, res.json);
      return { ok: true, data: { key, status } };
    },
  };

  const addComment: Tool = {
    name: 'jira_add_comment',
    impl: 'api',
    description: '给 Jira 单添加评论（进展汇报/遗留说明）',
    parameters: {
      key: { type: 'string', description: 'Jira 单号', required: true },
      body: { type: 'string', description: '评论内容', required: true },
    },
    async execute(args) {
      const key = String(args['key']);
      const body = String(args['body']);
      const res = await transport.request('POST', `/issue/${encodeURIComponent(key)}/comment`, { body });
      if (res.status !== 201 && res.status !== 200) return fail(res.status, res.json);
      return { ok: true, data: { key, commented: true } };
    },
  };

  return [getIssue, updateStatus, addComment];
}
