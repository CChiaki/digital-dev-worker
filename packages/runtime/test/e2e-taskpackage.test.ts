import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { parseTaskPackage } from '../src/task/package.js';
import { EmployeeRuntime, type AgentFactory } from '../src/runtime/employee-runtime.js';
import { ModelGateway } from '../src/model/gateway.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { EmployeeSessionStore, loadMessages } from '../src/session/employee-session.js';
import { EventBus } from '../src/events/bus.js';
import { createGitLabTools } from '../../mcp-gitlab/src/tools.js';
import type { GitLabTransport, GitLabResponse } from '../../mcp-gitlab/src/transport.js';
import { createJiraTools } from '../../mcp-jira/src/tools.js';
import type { JiraTransport } from '../../mcp-jira/src/transport.js';
import type { AgentEvent, ModelSpec, RouteConfig } from '../src/types.js';

const spec: ModelSpec = { name: 'qwen', baseUrl: 'http://model.local/v1', apiKey: 'k', model: 'qwen3.8-27b' };
const routes: RouteConfig[] = [{ callType: 'code', primary: spec }];

/** fake GitLab transport：记录请求，模拟行内 GitLab 行为 */
class FakeGitLab implements GitLabTransport {
  calls: { method: string; path: string; body?: unknown }[] = [];
  createdMr?: { iid: number; web_url: string };
  async request(method: string, path: string, body?: unknown): Promise<GitLabResponse> {
    this.calls.push({ method, path, body });
    if (method === 'GET' && path.includes('/merge_requests?')) return { status: 200, json: [] };
    if (method === 'POST' && path.includes('/merge_requests')) {
      this.createdMr = { iid: 42, web_url: 'http://gitlab.inner.bank/web-app/-/merge_requests/42' };
      return { status: 201, json: this.createdMr };
    }
    if (method === 'POST' && path.includes('/repository/branches?')) return { status: 201, json: { name: 'x' } };
    if (method === 'GET' && path.includes('/branches/')) return { status: 404, json: {} };
    if (method === 'GET' && path.includes('/files/')) return { status: 404, json: {} };
    if (method === 'POST' && path.includes('/commits')) return { status: 201, json: { commit_id: 'c1' } };
    return { status: 404, json: { message: 'not mocked' } };
  }
}

/** fake Jira transport */
class FakeJira implements JiraTransport {
  calls: { method: string; path: string; body?: unknown }[] = [];
  async request(method: string, path: string, body?: unknown) {
    this.calls.push({ method, path, body });
    if (method === 'GET' && path.includes('/transitions')) {
      return { status: 200, json: { transitions: [{ id: '21', name: '提交测试', to: { name: '待测试' } }] } };
    }
    if (method === 'POST' && path.includes('/transitions')) return { status: 204, json: null };
    return { status: 404, json: { message: 'not mocked' } };
  }
}

describe('P2 端到端：任务包 → 数字员工 → GitLab/Jira → MR', () => {
  it('yaml 任务包进，事件流可见 建分支/提交/建MR/改单 全过程，请求体正确，session 可 resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-e2e-'));
    try {
      const yaml = await readFile(new URL('../../../examples/task-package.example.yaml', import.meta.url), 'utf8');
      const pkg = parseTaskPackage(yaml);

      const gitlab = new FakeGitLab();
      const jira = new FakeJira();
      const tools = new ToolRegistry();
      for (const t of [...createGitLabTools({ transport: gitlab, defaultRepo: 'frontend/web-app' }), ...createJiraTools({ transport: jira })]) {
        tools.register(t);
      }

      // Faux 脚本：模型按任务简报顺序使用工具 → 汇报
      const factory: AgentFactory = (opts) => {
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall('gitlab_create_branch', { branch: 'feature/login-refactor', from: 'develop' })),
          fauxAssistantMessage(fauxToolCall('gitlab_commit_files', {
            branch: 'feature/login-refactor',
            message: 'feat(feature/login-refactor): 登录模块重构\n\n内容点:\n- src/views/login/index.vue: 登录页模板重构',
            files: [{ path: 'src/views/login/index.vue', content: '<template>...</template>' }],
          })),
          fauxAssistantMessage(fauxToolCall('task_check', { item: 'T-1', result: '现有登录 e2e 用例全绿' })),
          fauxAssistantMessage(fauxToolCall('gitlab_create_mr', {
            source: 'feature/login-refactor', target: 'develop', title: '登录模块前端重构',
          })),
          fauxAssistantMessage(fauxToolCall('jira_update_status', { key: pkg.taskId, status: '待测试' })),
          fauxAssistantMessage(fauxText('全部任务完成：MR !42 已创建，Jira 已流转到待测试。')),
        ]);
        return new Agent({
          initialState: {
            systemPrompt: opts.systemPrompt, model: faux.getModel(), tools: opts.tools,
          },
          streamFn: models.streamSimple.bind(models),
        });
      };

      const events = new EventBus();
      const received: AgentEvent[] = [];
      events.on('event', (e) => received.push(e));

      const rt = new EmployeeRuntime({
        gateway: new ModelGateway(routes),
        tools,
        interceptors: [],
        events,
        sessions: new EmployeeSessionStore(root),
        config: { employeeId: 'emp-01' },
        agentFactory: factory,
      });

      const outcome = await rt.runTaskPackage(pkg);

      // 结果
      expect(outcome.status).toBe('done');
      expect(outcome.reply).toContain('MR !42');

      // 事件流：5 个 tool_call（按序，含 task_check 申报本身的执行事件）+ thinking
      const toolEvents = received.filter((e) => e.type === 'tool_call');
      expect(toolEvents.map((e) => e.summary)).toEqual([
        'gitlab_create_branch', 'gitlab_commit_files', 'task_check', 'gitlab_create_mr', 'jira_update_status',
      ]);
      expect(received.filter((e) => e.type === 'thinking').length).toBeGreaterThanOrEqual(1);
      expect(toolEvents.every((e) => (e.payload as { isError?: boolean }).isError === false)).toBe(true);

      // 节点申报（spec 4.4 checkpoint）：task_check 事件在提交之后、MR 之前
      const checks = received.filter((e) => e.type === 'task_check');
      expect(checks).toHaveLength(1);
      expect(checks[0]!.summary).toContain('T-1');
      expect(checks[0]!.payload).toMatchObject({ item: 'T-1', passed: true });
      const order = received.map((e) => e.type === 'task_check' ? 'task_check' : e.summary);
      expect(order.indexOf('gitlab_commit_files')).toBeLessThan(order.indexOf('task_check'));
      expect(order.indexOf('task_check')).toBeLessThan(order.indexOf('gitlab_create_mr'));

      // fake GitLab 收到正确请求：分支名来自任务包
      const branchCall = gitlab.calls.find((c) => c.method === 'POST' && c.path.includes('/repository/branches?'))!;
      expect(branchCall.path).toContain('branch=feature%2Flogin-refactor&ref=develop');
      const mrCall = gitlab.calls.find((c) => c.method === 'POST' && c.path.endsWith('/merge_requests'))!;
      expect(mrCall.body).toMatchObject({ source_branch: 'feature/login-refactor', target_branch: 'develop' });
      // fake Jira 收到流转请求
      expect(jira.calls.some((c) => c.method === 'POST' && JSON.stringify(c.body ?? {}).includes('21'))).toBe(true);

      // session 落盘完整（含简报与汇报），可 resume
      const msgs = await loadMessages(await new EmployeeSessionStore(root).open(pkg.taskId));
      expect(msgs[0].role).toBe('user');
      expect(JSON.stringify(msgs[0])).toContain('feature/login-refactor');
      expect(JSON.stringify(msgs.at(-1))).toContain('MR !42');
      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });
});
