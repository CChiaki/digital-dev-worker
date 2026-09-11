import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import {
  EmployeeRuntime, type AgentFactory,
  ModelGateway, ToolRegistry, EmployeeSessionStore, EventBus, JsonlSink,
  LocalWorkspace, createWorkspaceTools, createBashTool, ControlledBash,
  BwrapBackend, NoopBackend,
  parseTaskPackage,
  type ModelSpec, type RouteConfig, type TaskPackage,
} from '@ddw/runtime';
import { createGitLabTools } from '@ddw/mcp-gitlab';
import type { GitLabTransport, GitLabResponse } from '@ddw/mcp-gitlab';
import { createJiraTools } from '@ddw/mcp-jira';
import type { JiraTransport } from '@ddw/mcp-jira';
import { createCiTools } from '@ddw/mcp-ci';
import type { CiTransport, BuildInfo } from '@ddw/mcp-ci';
import { createDeployTools } from '@ddw/mcp-deploy';
import type { DeployTransport, DeployInfo } from '@ddw/mcp-deploy';
import { createTestenvTools } from '@ddw/mcp-testenv';
import type { TestenvTransport } from '@ddw/mcp-testenv';
import { createHandlers } from '../src/http/handlers.js';
import { createSseHandler } from '../src/http/sse.js';
import { FileTaskStore, FileEventStore, SqlTaskStore, SqlEventStore } from '../src/stores/index.js';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import type { TaskStore, EventStore } from '../src/stores/index.js';

const sh = promisify(execFile);

const BUGGY_SUM = `function sum(a, b) { return a - b; }\nmodule.exports = { sum };\n`;
const SUM_TEST = `const assert = require('assert');
const { sum } = require('../src/sum.js');
assert.strictEqual(sum(1, 2), 3);
console.log('ALL TESTS PASSED');
`;

const YAML = `taskId: TASK-P5-E2E
title: sum 修复并走完 发布 全链路
repo:
  url: http://gitlab.inner.bank/frontend/web-app.git
  branch: fix/sum
tasks:
  - id: T-1
    title: 修复 sum 并发布到验证环境
    files: [src/sum.js]
    requirement: sum 应返回 a+b，且发布验证环境健康
    acceptance: [自测通过, MR 已创建, 构建成功, 验证环境健康]
`;

// ---------- fake transports（全离线） ----------

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

class FakeCi implements CiTransport {
  private poll = 0;
  triggered: { project: string; ref: string } | null = null;
  async triggerBuild(req: { project: string; ref: string }): Promise<{ id: string }> {
    this.triggered = req;
    return { id: 'B-9' };
  }
  async getBuild(id: string): Promise<BuildInfo> {
    // fake 依次 running → success
    return { id, status: this.poll++ === 0 ? 'running' : 'success' };
  }
  async getLog(id: string): Promise<string> {
    return `[${id}] build ok`;
  }
}

class FakeDeploy implements DeployTransport {
  private poll = 0;
  deployed: { project: string; env: string; version: string } | null = null;
  async deploy(req: { project: string; env: 'test' | 'staging'; version: string }): Promise<{ id: string; status: string }> {
    this.deployed = req;
    return { id: 'D-9', status: 'deploying' };
  }
  async getDeploy(id: string): Promise<DeployInfo> {
    return { id, status: this.poll++ === 0 ? 'deploying' : 'done' };
  }
}

class FakeTestenv implements TestenvTransport {
  checked: string[] = [];
  async check(url: string): Promise<{ status: number; body: string }> {
    this.checked.push(url);
    return { status: 200, body: 'UP version=1.2.3' };
  }
}

// ---------- 全链路（双存储实现等价验证，spec 5.2） ----------

/**
 * 同一 Faux 脚本 + 真实 git 工作区，分别对 file / sqlite 存储跑完整链路：
 * 接单→编码→MR→Jira→构建→部署→环境验证→汇报，事件/审计/SSE 断言等价。
 */
async function runFullChain(kind: 'file' | 'sqlite'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ddw-e2e-chain-ws-')); // git 工作区
  const dataDir = await mkdtemp(join(tmpdir(), 'ddw-e2e-chain-data-')); // 控制台数据目录
  const sessionRoot = await mkdtemp(join(tmpdir(), 'ddw-e2e-chain-sessions-'));

  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'src/sum.js'), BUGGY_SUM, 'utf8');
    await writeFile(join(root, 'test/sum.test.js'), SUM_TEST, 'utf8');
    await sh('git', ['init', '-q', root]);
    await sh('git', ['-C', root, 'config', 'user.email', 'emp-01@ddw.bank']);
    await sh('git', ['-C', root, 'config', 'user.name', 'emp-01']);
    await sh('git', ['-C', root, 'add', '-A']);
    await sh('git', ['-C', root, 'commit', '-q', '-m', 'chore: 初始（含 bug）']);
    const pkg: TaskPackage = parseTaskPackage(YAML);

    // 0. SandboxBackend 硬防线中间层 argv 断言（不真执行 bwrap/docker，只验证命令翻译）
    const bwrap = new BwrapBackend({ workspace: root });
    const wrapped = bwrap.wrap(['node', 'test/sum.test.js']);
    expect(wrapped.slice(0, 2)).toEqual(['bwrap', '--ro-bind']);
    expect(wrapped).toContain('--unshare-net'); // 默认断网
    expect(wrapped.at(-3)).toBe('--');
    expect(wrapped.slice(-2)).toEqual(['node', 'test/sum.test.js']);
    expect(new NoopBackend().wrap(['git', 'status'])).toEqual(['git', 'status']);

    // 1. 任务包入库 → 接单（控制台链路；存储实现按 kind 注入，业务端零差异）
    const tasks: TaskStore = kind === 'file'
      ? new FileTaskStore(dataDir)
      : await (async () => {
          const driver = new SqliteDriver(join(dataDir, 'ddw.sqlite'));
          await driver.ensureSchema();
          return new SqlTaskStore(driver);
        })();
    const events: EventStore = kind === 'file' ? new FileEventStore(dataDir) : await (async () => {
      // 存储企业化 Task 3：事件流同走 SqlDriver（表 ddw_events）；快照路径与 server 落点一致（`<dataDir>/audit-heads.jsonl`）
      const driver = new SqliteDriver(join(dataDir, 'ddw.sqlite'));
      await driver.ensureSchema();
      return new SqlEventStore(driver, { headsPath: join(dataDir, 'audit-heads.jsonl') });
    })();
    const handle = createHandlers({ tasks, events });
    const rec = await tasks.add(pkg);
    const taskId = rec.pkg.taskId;
    await tasks.claim(taskId, 'emp-01');
    await tasks.markRunning(taskId);

    // 2. 事件经 EventBus → EventStore append 落盘（带审计 hash 链；直播/审计同源）
    const bus = new EventBus();
    bus.addSink({ write: (e) => events.append(e) });

    // 3. 全工具集：工作区编码 + 远端协作 + 发布三件套
    const ws = new LocalWorkspace(root);
    const fakeCi = new FakeCi();
    const fakeDeploy = new FakeDeploy();
    const fakeTestenv = new FakeTestenv();
    const tools = new ToolRegistry();
    for (const t of [
      ...createWorkspaceTools(ws),
      createBashTool(new ControlledBash({ root, whitelist: ['git', 'node'], timeoutMs: 30_000 })),
      ...createGitLabTools({ transport: new FakeGitLab(), defaultRepo: 'frontend/web-app' }),
      ...createJiraTools({ transport: new FakeJira() }),
      ...createCiTools({ transport: fakeCi, waitOpts: { intervalMs: 1 } }),
      ...createDeployTools({ transport: fakeDeploy, waitOpts: { intervalMs: 1 } }),
      ...createTestenvTools({ transport: fakeTestenv }),
    ]) {
      tools.register(t);
    }

    // 4. Faux 数字员工脚本：编码→自测→提交→MR→Jira→构建→部署→环境验证→汇报
    const factory: AgentFactory = (opts) => {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('read_file', { path: 'src/sum.js' })),
        fauxAssistantMessage(fauxToolCall('edit_file', { path: 'src/sum.js', oldText: 'return a - b;', newText: 'return a + b;' })),
        fauxAssistantMessage(fauxToolCall('run_cmd', { cmd: 'node test/sum.test.js' })),
        fauxAssistantMessage(fauxToolCall('run_cmd', { cmd: 'git add src/sum.js' })),
        fauxAssistantMessage(fauxToolCall('run_cmd', { cmd: 'git commit -m "fix: sum 修复为加法"' })),
        fauxAssistantMessage(fauxToolCall('task_check', { item: 'T-1', result: 'node test/sum.test.js 3 断言全绿，已提交' })),
        fauxAssistantMessage(fauxToolCall('gitlab_create_branch', { branch: 'fix/sum', from: 'master' })),
        fauxAssistantMessage(fauxToolCall('gitlab_commit_files', {
          branch: 'fix/sum', message: 'fix(fix/sum): sum 修复为加法\n\n内容点:\n- src/sum.js: return a - b 修复为 return a + b',
          files: [{ path: 'src/sum.js', content: 'function sum(a, b) { return a + b; }\nmodule.exports = { sum };\n' }],
        })),
        fauxAssistantMessage(fauxToolCall('gitlab_create_mr', { source: 'fix/sum', target: 'master', title: 'sum 修复' })),
        fauxAssistantMessage(fauxToolCall('jira_update_status', { key: taskId, status: '待测试' })),
        fauxAssistantMessage(fauxToolCall('ci_trigger_build', { project: 'frontend/web-app', ref: 'fix/sum' })),
        fauxAssistantMessage(fauxToolCall('ci_wait_build', { id: 'B-9' })),
        fauxAssistantMessage(fauxToolCall('deploy_to_env', { project: 'frontend/web-app', env: 'test', version: '1.2.3' })),
        fauxAssistantMessage(fauxToolCall('deploy_wait', { id: 'D-9' })),
        fauxAssistantMessage(fauxToolCall('testenv_check_health', { url: 'http://testenv.local/web-app/health', contains: 'UP' })),
        fauxAssistantMessage(fauxText('任务完成：sum 已修复，自测通过并已提交；MR !42 已创建，Jira 流转到待测试；构建 B-9 成功，已部署 test 环境并健康检查通过。')),
      ]);
      return new Agent({
        initialState: { systemPrompt: opts.systemPrompt, model: faux.getModel(), tools: opts.tools },
        streamFn: models.streamSimple.bind(models),
      });
    };

    const spec: ModelSpec = { name: 'qwen', baseUrl: 'http://model.local/v1', apiKey: 'k', model: 'qwen3.8-27b' };
    const routes: RouteConfig[] = [{ callType: 'code', primary: spec }];
    const rt = new EmployeeRuntime({
      gateway: new ModelGateway(routes), tools, interceptors: [], events: bus,
      sessions: new EmployeeSessionStore(sessionRoot), config: { employeeId: 'emp-01' },
      agentFactory: factory,
    });

    // 5. 执行全链路
    const outcome = await rt.runTaskPackage(pkg);
    expect(outcome.status).toBe('done');
    expect(outcome.reply).toContain('健康检查通过');
    await tasks.finish(taskId, outcome, true);

    // 6a. 现实世界：文件真实修复 + 自测真实通过 + git 真实提交
    expect(await readFile(join(root, 'src/sum.js'), 'utf8')).toContain('return a + b;');
    const test = await sh('node', [join(root, 'test/sum.test.js')]);
    expect(test.stdout).toContain('ALL TESTS PASSED');
    const log = await sh('git', ['-C', root, 'log', '--oneline']);
    expect(log.stdout.split('\n')[0]).toContain('fix: sum 修复为加法');

    // 6b. 远端协作链路参数正确
    expect(fakeCi.triggered).toEqual({ project: 'frontend/web-app', ref: 'fix/sum' });
    expect(fakeDeploy.deployed).toEqual({ project: 'frontend/web-app', env: 'test', version: '1.2.3' });
    expect(fakeTestenv.checked).toEqual(['http://testenv.local/web-app/health']);

    // 6c. 事件流全链路按序（15 个 tool_call：编码 5 + 节点申报 + 协作 4 + 发布 5）
    const live = await handle({ method: 'GET', path: '/api/events', query: { taskId } });
    const summaries = (live.json as { type: string; summary: string }[])
      .filter((e) => e.type === 'tool_call').map((e) => e.summary);
    expect(summaries.length).toBeGreaterThanOrEqual(12);
    expect(summaries).toEqual([
      'read_file', 'edit_file', 'run_cmd', 'run_cmd', 'run_cmd', 'task_check',
      'gitlab_create_branch', 'gitlab_commit_files', 'gitlab_create_mr', 'jira_update_status',
      'ci_trigger_build', 'ci_wait_build', 'deploy_to_env', 'deploy_wait', 'testenv_check_health',
    ]);
    // 节点申报事件在编码段之后、MR 之前（spec 4.4 checkpoint）
    const allEvents = live.json as { type: string }[];
    expect(allEvents.filter((e) => e.type === 'task_check')).toHaveLength(1);

    // 6d. 审计台账 v2：任务级聚合（状态 + 时间线 + 工具统计 + 回复）
    const audit = await handle({ method: 'GET', path: `/api/audit/${taskId}` });
    expect(audit.status).toBe(200);
    const auditBody = audit.json as {
      task: { status: string };
      timeline: { id: string }[];
      toolCalls: { name: string; count: number; errors: number }[];
      reply?: string;
    };
    expect(auditBody.task.status).toBe('done');
    expect(auditBody.reply).toContain('MR !42');
    // timeline = tool_call + thinking + task_check 事件（数量随 Faux 轮次，弹性断言）
    expect(auditBody.timeline.length).toBeGreaterThanOrEqual(summaries.length + 1);
    const byName = Object.fromEntries(auditBody.toolCalls.map((t) => [t.name, t]));
    expect(byName['run_cmd']).toEqual({ name: 'run_cmd', count: 3, errors: 0 });
    expect(byName['task_check']).toEqual({ name: 'task_check', count: 1, errors: 0 });
    expect(byName['gitlab_commit_files']).toEqual({ name: 'gitlab_commit_files', count: 1, errors: 0 });
    expect(byName['testenv_check_health']).toEqual({ name: 'testenv_check_health', count: 1, errors: 0 });

    // 6e. 审计 hash 链：全链路事件落库后完整性校验通过（spec 5.2）
    const integrityRes = await handle({ method: 'GET', path: '/api/audit', query: { integrity: '1' } });
    const integrity = (integrityRes.json as { integrity?: { ok: boolean; total: number } }).integrity;
    expect(integrity).toBeDefined();
    expect(integrity!.ok).toBe(true);
    expect(integrity!.total).toBeGreaterThanOrEqual(allEvents.length);

    // 6f. SSE 直播流：含末段（环境验证）事件帧
    const sse = createSseHandler(events, { intervalMs: 5, maxDurationMs: 60 });
    const chunks: string[] = [];
    const mockRes = {
      writeHead() {},
      write(c: string) { chunks.push(c); return true; },
      end() {},
    };
    await sse({ path: '/api/events/stream', query: { taskId } }, mockRes);
    const sseText = chunks.join('');
    expect(sseText).toContain('event: agent-event');
    expect(sseText).toContain('testenv_check_health'); // 末段事件在直播帧里

    (tasks as { close?: () => void }).close?.();
    (events as { close?: () => void }).close?.();
  } finally {
    for (const dir of [root, dataDir, sessionRoot]) await rm(dir, { recursive: true, force: true });
  }
}

describe('P5/P7 端到端：接单→编码→MR→Jira→构建→部署→环境验证→汇报 全链路闭环', () => {
  it('file 存储实现', () => runFullChain('file'), 60_000);

  it('sqlite 存储实现（同 Faux 脚本、断言等价 + integrity ok）', () => runFullChain('sqlite'), 60_000);
});
