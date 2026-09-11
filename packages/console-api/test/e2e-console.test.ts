import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { createHandlers } from '../src/http/handlers.js';
import { FileTaskStore, FileEventStore } from '../src/stores/index.js';
import {
  EmployeeRuntime, type AgentFactory,
  ModelGateway, ToolRegistry, EmployeeSessionStore, EventBus, JsonlSink,
  type ModelSpec, type RouteConfig,
} from '@ddw/runtime';
import { createGitLabTools } from '@ddw/mcp-gitlab';
import type { GitLabTransport, GitLabResponse } from '@ddw/mcp-gitlab';
import { createJiraTools } from '@ddw/mcp-jira';
import type { JiraTransport } from '@ddw/mcp-jira';

let root: string;
let sessionRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-e2e-console-'));
  // session 落盘目录与控制台数据目录分开（session JSONL 不是 AgentEvent 流）
  sessionRoot = await mkdtemp(join(tmpdir(), 'ddw-e2e-sessions-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(sessionRoot, { recursive: true, force: true });
});

class FakeGitLab implements GitLabTransport {
  async request(method: string, path: string): Promise<GitLabResponse> {
    if (method === 'GET' && path.includes('/merge_requests?')) return { status: 200, json: [] };
    if (method === 'POST' && path.includes('/merge_requests'))
      return { status: 201, json: { iid: 42, web_url: 'http://gitlab.inner.bank/web-app/-/merge_requests/42' } };
    if (method === 'POST' && path.includes('/repository/branches?')) return { status: 201, json: { name: 'x' } };
    if (method === 'GET' && path.includes('/branches/')) return { status: 404, json: {} };
    if (method === 'GET' && path.includes('/files/')) return { status: 404, json: {} };
    if (method === 'POST' && path.includes('/commits')) return { status: 201, json: { commit_id: 'c1' } };
    return { status: 404, json: { message: 'not mocked' } };
  }
}

class FakeJira implements JiraTransport {
  async request(method: string, path: string) {
    if (method === 'GET' && path.includes('/transitions'))
      return { status: 200, json: { transitions: [{ id: '21', name: '提交测试', to: { name: '待测试' } }] } };
    if (method === 'POST' && path.includes('/transitions')) return { status: 204, json: null };
    return { status: 404, json: { message: 'not mocked' } };
  }
}

describe('P3 端到端：固化任务包 → 接单 → 数字员工执行 → 直播/审计/状态', () => {
  it('控制台 API 全程可见数字员工接单干活', async () => {
    const tasks = new FileTaskStore(root);
    const events = new FileEventStore(root);
    const handle = createHandlers({ tasks, events });

    // 1. 固化任务包
    const yaml = await readFile(
      new URL('../../../examples/task-package.example.yaml', import.meta.url),
      'utf8',
    );
    const created = await handle({ method: 'POST', path: '/api/tasks', body: yaml });
    expect(created.status).toBe(201);
    const taskId = (created.json as { taskId: string }).taskId;
    await handle({ method: 'POST', path: `/api/tasks/${taskId}/publish`, body: {} });

    // 2. 接单
    const claimed = await handle({
      method: 'POST', path: `/api/tasks/${taskId}/claim`, body: { employeeId: 'emp-01' },
    });
    expect(claimed.status).toBe(200);

    // 3. 执行方（同进程模拟 worker）：标记 running，事件经 EventBus 落盘到控制台数据目录
    await tasks.markRunning(taskId);
    const bus = new EventBus();
    bus.addSink(new JsonlSink(join(root, 'events.jsonl')));

    const spec: ModelSpec = { name: 'qwen', baseUrl: 'http://model.local/v1', apiKey: 'k', model: 'qwen3.8-27b' };
    const routes: RouteConfig[] = [{ callType: 'code', primary: spec }];
    const tools = new ToolRegistry();
    for (const t of [
      ...createGitLabTools({ transport: new FakeGitLab(), defaultRepo: 'frontend/web-app' }),
      ...createJiraTools({ transport: new FakeJira() }),
    ]) {
      tools.register(t);
    }

    const factory: AgentFactory = (opts) => {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('gitlab_create_branch', { branch: 'feature/login-refactor', from: 'develop' })),
        fauxAssistantMessage(fauxToolCall('gitlab_commit_files', {
          branch: 'feature/login-refactor', message: 'feat(feature/login-refactor): 登录模块重构\n\n内容点:\n- src/views/login/index.vue: 重构登录表单与校验',
          files: [{ path: 'src/views/login/index.vue', content: '<template>...</template>' }],
        })),
        fauxAssistantMessage(fauxToolCall('gitlab_create_mr', {
          source: 'feature/login-refactor', target: 'develop', title: '登录模块前端重构',
        })),
        fauxAssistantMessage(fauxToolCall('jira_update_status', { key: taskId, status: '待测试' })),
        fauxAssistantMessage(fauxText('全部任务完成：MR !42 已创建，Jira 已流转到待测试。')),
      ]);
      return new Agent({
        initialState: { systemPrompt: opts.systemPrompt, model: faux.getModel(), tools: opts.tools },
        streamFn: models.streamSimple.bind(models),
      });
    };

    const rt = new EmployeeRuntime({
      gateway: new ModelGateway(routes), tools, interceptors: [], events: bus,
      sessions: new EmployeeSessionStore(sessionRoot), config: { employeeId: 'emp-01' },
      agentFactory: factory,
    });
    const record = await tasks.get(taskId);
    const outcome = await rt.runTaskPackage(record!.pkg);
    expect(outcome.status).toBe('done');

    await tasks.finish(taskId, outcome, true);

    // 4a. 直播：GET /api/events?taskId= 事件完整（4 工具调用按序 + thinking）
    const live = await handle({ method: 'GET', path: '/api/events', query: { taskId } });
    expect(live.status).toBe(200);
    const toolEvents = (live.json as { type: string; summary: string }[]).filter((e) => e.type === 'tool_call');
    expect(toolEvents.map((e) => e.summary)).toEqual([
      'gitlab_create_branch', 'gitlab_commit_files', 'gitlab_create_mr', 'jira_update_status',
    ]);
    expect((live.json as { type: string }[]).some((e) => e.type === 'thinking')).toBe(true);

    // 4b. 审计台账：倒序 + 汇总
    const audit = await handle({ method: 'GET', path: '/api/audit' });
    const body = audit.json as { total: number; byType: Record<string, number>; events: { ts: number }[] };
    expect(body.byType['tool_call']).toBe(4);
    expect(body.byType['thinking']).toBeGreaterThanOrEqual(1);
    const tsList = body.events.map((e) => e.ts);
    expect([...tsList].sort((a, b) => b - a)).toEqual(tsList); // 倒序

    // 4c. 任务状态回写 done
    const detail = await handle({ method: 'GET', path: `/api/tasks/${taskId}` });
    expect(detail.json).toMatchObject({ status: 'done' });
    expect((detail.json as { result?: { reply: string } }).result?.reply).toContain('MR !42');
  });
});
