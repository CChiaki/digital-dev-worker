import { describe, it, expect } from 'vitest';
import { createJiraTools } from '../src/tools.js';
import type { JiraTransport, JiraResponse } from '../src/transport.js';
import type { Tool } from '@ddw/runtime';

class FakeTransport implements JiraTransport {
  calls: { method: string; path: string; body?: unknown }[] = [];
  constructor(private routes: {
    match: (method: string, path: string) => boolean;
    respond: () => JiraResponse;
  }[]) {}

  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<JiraResponse> {
    this.calls.push({ method, path, body });
    const r = this.routes.find((r) => r.match(method, path));
    if (!r) return { status: 404, json: { message: 'not mocked' } };
    return r.respond();
  }
}

const tools = (t: FakeTransport): Map<string, Tool> =>
  new Map(createJiraTools({ transport: t }).map((tool) => [tool.name, tool]));

describe('jira_get_issue', () => {
  it('抽取 summary/status/description', async () => {
    const t = new FakeTransport([
      {
        match: (m, p) => m === 'GET' && p.includes('/issue/TASK-123'),
        respond: () => ({
          status: 200,
          json: { key: 'TASK-123', fields: { summary: '登录重构', status: { name: '开发中' }, description: '重构登录页' } },
        }),
      },
    ]);
    const r = await tools(t).get('jira_get_issue')!.execute({ key: 'TASK-123' });
    expect(r).toEqual({
      ok: true,
      data: { key: 'TASK-123', summary: '登录重构', status: '开发中', description: '重构登录页' },
    });
  });

  it('单号不存在 → ok:false', async () => {
    const t = new FakeTransport([
      { match: () => true, respond: () => ({ status: 404, json: { message: 'Issue Does Not Exist' } }) },
    ]);
    const r = await tools(t).get('jira_get_issue')!.execute({ key: 'NOPE-1' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('Jira 404');
  });
});

describe('jira_update_status', () => {
  it('两步流转：查 transitions → POST transition id', async () => {
    const t = new FakeTransport([
      {
        match: (m, p) => m === 'GET' && p.includes('/transitions'),
        respond: () => ({
          status: 200,
          json: { transitions: [{ id: '31', name: '开始开发', to: { name: '开发中' } }] },
        }),
      },
      { match: (m, p) => m === 'POST' && p.includes('/transitions'), respond: () => ({ status: 204, json: null }) },
    ]);
    const r = await tools(t).get('jira_update_status')!.execute({ key: 'TASK-123', status: '开发中' });
    expect(r).toEqual({ ok: true, data: { key: 'TASK-123', status: '开发中' } });
    const post = t.calls.at(-1)!;
    expect(post.body).toEqual({ transition: { id: '31' } });
  });

  it('目标状态不可达 → ok:false 并列出可用状态', async () => {
    const t = new FakeTransport([
      {
        match: (m) => m === 'GET',
        respond: () => ({ status: 200, json: { transitions: [{ id: '11', name: '关闭', to: { name: '已关闭' } }] } }),
      },
    ]);
    const r = await tools(t).get('jira_update_status')!.execute({ key: 'TASK-123', status: '待测试' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('已关闭');
  });
});

describe('jira_add_comment', () => {
  it('评论请求体正确', async () => {
    const t = new FakeTransport([
      { match: (m, p) => m === 'POST' && p.includes('/comment'), respond: () => ({ status: 201, json: { id: '9001' } }) },
    ]);
    const r = await tools(t).get('jira_add_comment')!.execute({ key: 'TASK-123', body: 'MR 已创建' });
    expect(r).toEqual({ ok: true, data: { key: 'TASK-123', commented: true } });
    expect(t.calls[0].body).toEqual({ body: 'MR 已创建' });
  });
});
