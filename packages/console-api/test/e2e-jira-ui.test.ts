import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import {
  EmployeeRuntime, EmployeeSessionStore, ModelGateway, ToolRegistry, EventBus, parseTaskPackage,
  type AgentFactory, type EmployeeProfile, type ModelSpec,
} from '@ddw/runtime';
import { FakeDriver } from '@ddw/mcp-browser';
import { createJiraUiTools, JIRA_UI_SELECTORS } from '@ddw/mcp-jira';
import { FileTaskStore, FileEventStore } from '../src/stores/index.js';
import { createRuntimePipeline, type RuntimePipeline } from '../src/team/pipeline.js';

/**
 * P14-T3 e2e（数字员工经 UI 通道流转 Jira，spec 7.3 垫片闭环）：
 * faux 员工依次 jira_get_issue → jira_update_status → jira_add_comment（createJiraUiTools 注册，
 * FakeDriver 内存页面 + 登录态）→ 任务 done；tool_call 全留痕（summary=工具名，result 带
 * screenshot 证据）；审计 hash 链完整。同契约 api/ui 互换数字员工侧零改动的证明。
 */

const YAML = `
taskId: P14-JIRA/1
title: UI 通道 Jira 流转
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
tasks: [{ id: T-1, title: t, files: [src/main.js], requirement: r, acceptance: [a] }]
`;

const S = JIRA_UI_SELECTORS;

let root: string;
let driver: FakeDriver;
let events: FileEventStore;
let tasks: FileTaskStore;
let pipeline: RuntimePipeline;

const profile: EmployeeProfile = { id: 'emp-01', name: '小数', role: 'backend', skills: ['backend'], supervision: { level: 'assisted' } };

const factory: AgentFactory = (opts) => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('jira_get_issue', { key: 'TASK-77' })),
    fauxAssistantMessage(fauxToolCall('jira_update_status', { key: 'TASK-77', status: '开发中' })),
    fauxAssistantMessage(fauxToolCall('jira_add_comment', { key: 'TASK-77', body: '已开始开发，预计明日提 MR' })),
    fauxAssistantMessage(fauxText('Jira 单已流转到开发中并留言')),
  ]);
  return new Agent({
    initialState: { systemPrompt: opts.systemPrompt, model: faux.getModel(), tools: opts.tools },
    streamFn: models.streamSimple.bind(models),
  });
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-jira-ui-e2e-'));
  const dataDir = join(root, 'data');
  tasks = new FileTaskStore(dataDir);
  events = new FileEventStore(dataDir);

  // Jira 页面模型：登录 + 详情页字段；update_status 前后状态可编程
  driver = new FakeDriver();
  driver.requireLogin = { user: 'emp-01', pass: 'secret-pw' };
  driver.onText(S.summary, '完善消息通知');
  driver.onText(S.status, '待开发');
  driver.onText(S.description, '通知渠道：站内信');
  // 流转点击真实生效：状态字段 '待开发' → '开发中'
  driver.onClick(S.transitionItem('开发中'), { [S.status]: '开发中' });

  // 同契约 ui 注入：数字员工视角只是 jira_* 工具，无感知 api/ui 之别
  const tools = new ToolRegistry();
  for (const t of createJiraUiTools({
    driver,
    options: {
      baseUrl: 'http://jira.inner.bank',
      login: { entryUrl: 'http://jira.inner.bank/secure/Dashboard.jspa', credentials: { username: 'emp-01', password: 'secret-pw' } },
    },
  })) {
    tools.register(t);
  }

  const bus = new EventBus();
  bus.addSink({ write: (e) => events.append(e) });
  const spec: ModelSpec = { name: 'glm', baseUrl: 'http://model-cluster.inner.bank/v1', apiKey: 'k', model: 'glm-5.3-flash' };

  pipeline = createRuntimePipeline(
    { tasks, events },
    {
      profiles: [profile],
      workspaceRoot: join(root, 'ws'),
      sessionsRoot: join(root, 'sessions'),
      routes: [{ callType: 'code', primary: spec }],
      executor: ({ task, employee }) => {
        const runtime = new EmployeeRuntime({
          gateway: new ModelGateway([{ callType: 'code', primary: spec }]),
          tools,
          interceptors: [],
          events: bus,
          sessions: new EmployeeSessionStore(join(root, 'sessions', employee.id)),
          config: { employeeId: employee.id, supervision: employee.supervision },
          agentFactory: factory,
        });
        return runtime.runTaskPackage(task);
      },
    },
  );

  await tasks.add(parseTaskPackage(YAML));
  await pipeline.scheduler.tick();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function waitDone(): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if ((await tasks.get('P14-JIRA/1'))?.status === 'done') return;
    if (Date.now() > deadline) throw new Error(`等待任务 done 超时，当前: ${(await tasks.get('P14-JIRA/1'))?.status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('P14 e2e：数字员工经 UI 通道完成 Jira 流转', () => {
  it('查单 → 流转 → 评论一条链 done，UI 动作与登录态全部真实发生', async () => {
    await waitDone();
    expect(driver.authed).toBe(true); // 登录态闭环真实走通
    const clicks = driver.actions.filter((a) => (a as unknown[])[0] === 'click').map((a) => (a as unknown[])[1]);
    expect(clicks).toContain(S.transitionTrigger);
    expect(clicks).toContain(S.transitionItem('开发中'));
    expect(clicks).toContain(S.commentSubmit);
    const fills = driver.actions.filter((a) => (a as unknown[])[0] === 'fill');
    expect(fills).toContainEqual(['fill', S.commentInput, '已开始开发，预计明日提 MR']);
  });

  it('tool_call 全留痕：三工具 summary + result 带 screenshot 证据；审计 hash 链完整', async () => {
    await waitDone();
    const all = await events.list();
    const toolCalls = all.filter((e) => e.type === 'tool_call');
    expect(toolCalls.map((e) => e.summary)).toEqual(['jira_get_issue', 'jira_update_status', 'jira_add_comment']);
    for (const e of toolCalls) {
      // 工具 result（含 screenshot 审计证据）进事件 payload，直播/审计可见
      expect(JSON.stringify(e.payload)).toContain('screenshot');
      expect((e.payload as { isError?: boolean }).isError).toBeFalsy();
    }
    // 同契约双实现可枚举（spec 7.3 注册表标注）
    expect(all.filter((e) => e.employeeId === 'emp-01').length).toBeGreaterThan(0);
    expect(await events.verifyIntegrity()).toMatchObject({ ok: true });
  });
});
