import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import {
  EmployeeRuntime, type AgentFactory,
  ModelGateway, ToolRegistry, EmployeeSessionStore, EventBus, LocalWorkspace,
  createWorkspaceTools, createBashTool, ControlledBash,
  parseTaskPackage,
  type ModelSpec, type RouteConfig, type AgentEvent, type TaskPackage,
} from '../src/index.js';

const sh = promisify(execFile);

const BUGGY_SUM = `function sum(a, b) { return a - b; }\nmodule.exports = { sum };\n`;
const SUM_TEST = `const assert = require('assert');
const { sum } = require('../src/sum.js');
assert.strictEqual(sum(1, 2), 3);
assert.strictEqual(sum(0, 5), 5);
assert.strictEqual(sum(-1, 1), 0);
console.log('ALL TESTS PASSED');
`;

const YAML = `taskId: TASK-P4-E2E
title: sum 函数修复
repo:
  url: http://gitlab.inner.bank/frontend/web-app.git
  branch: fix/sum
tasks:
  - id: T-1
    title: 修复 sum 加法 bug
    files: [src/sum.js]
    requirement: sum 应返回 a+b
    acceptance: [node test/sum.test.js 通过]
`;

let root: string;
let sessionRoot: string;
let pkg: TaskPackage;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-e2e-ws-'));
  sessionRoot = await mkdtemp(join(tmpdir(), 'ddw-e2e-ws-sessions-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'src/sum.js'), BUGGY_SUM, 'utf8');
  await writeFile(join(root, 'test/sum.test.js'), SUM_TEST, 'utf8');
  await sh('git', ['init', '-q', root]);
  await sh('git', ['-C', root, 'config', 'user.email', 'emp-01@ddw.bank']);
  await sh('git', ['-C', root, 'config', 'user.name', 'emp-01']);
  await sh('git', ['-C', root, 'add', '-A']);
  await sh('git', ['-C', root, 'commit', '-q', '-m', 'chore: 初始（含 bug）']);
  pkg = parseTaskPackage(YAML);
}, 30_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(sessionRoot, { recursive: true, force: true });
});

describe('P4 端到端：数字员工在工作区 读代码→修bug→自测→git提交', () => {
  it('真实文件系统 + 真实 git + 受控 bash 全链路', async () => {
    // 初始自测确认确实失败（bug 存在）
    await expect(sh('node', [join(root, 'test/sum.test.js')])).rejects.toThrow();

    const ws = new LocalWorkspace(root);
    const tools = new ToolRegistry();
    for (const t of [
      ...createWorkspaceTools(ws),
      createBashTool(new ControlledBash({ root, whitelist: ['git', 'node'], timeoutMs: 30_000 })),
    ]) {
      tools.register(t);
    }

    const factory: AgentFactory = (opts) => {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('read_file', { path: 'src/sum.js' })),
        fauxAssistantMessage(fauxToolCall('edit_file', {
          path: 'src/sum.js', oldText: 'return a - b;', newText: 'return a + b;',
        })),
        fauxAssistantMessage(fauxToolCall('run_cmd', { cmd: 'node test/sum.test.js' })),
        fauxAssistantMessage(fauxToolCall('run_cmd', { cmd: 'git add src/sum.js' })),
        fauxAssistantMessage(fauxToolCall('run_cmd', { cmd: 'git commit -m "fix: sum 修复为加法"' })),
        fauxAssistantMessage(fauxText('任务完成：sum 已修复为 a+b，3 个断言自测通过，已提交 fix/sum。')),
      ]);
      return new Agent({
        initialState: {
          systemPrompt: opts.systemPrompt,
          model: faux.getModel(),
          tools: opts.tools,
          messages: opts.messages,
        },
        streamFn: models.streamSimple.bind(models),
      });
    };

    const events = new EventBus();
    const received: AgentEvent[] = [];
    events.on('event', (e) => received.push(e));

    const rt = new EmployeeRuntime({
      gateway: new ModelGateway([{ callType: 'code', primary: { name: 'q', baseUrl: 'http://m.local/v1', apiKey: 'k', model: 'q3' } }]),
      tools,
      interceptors: [],
      events,
      sessions: new EmployeeSessionStore(sessionRoot),
      config: { employeeId: 'emp-01' },
      agentFactory: factory,
    });

    const outcome = await rt.runTaskPackage(pkg);
    expect(outcome.status).toBe('done');
    expect(outcome.reply).toContain('自测通过');

    // 1. 文件真实修复
    expect(await readFile(join(root, 'src/sum.js'), 'utf8')).toContain('return a + b;');

    // 2. node 自测真实通过
    const test = await sh('node', [join(root, 'test/sum.test.js')]);
    expect(test.stdout).toContain('ALL TESTS PASSED');

    // 3. git 真实新增提交
    const log = await sh('git', ['-C', root, 'log', '--oneline']);
    expect(log.stdout.split('\n')[0]).toContain('fix: sum 修复为加法');
    expect(log.stdout.split('\n').length).toBeGreaterThanOrEqual(2);

    // 4. 事件流顺序：read → edit → run_cmd×3
    const summaries = received.filter((e) => e.type === 'tool_call').map((e) => e.summary);
    expect(summaries).toEqual(['read_file', 'edit_file', 'run_cmd', 'run_cmd', 'run_cmd']);
    expect(received.some((e) => e.type === 'thinking')).toBe(true);

    // 5. session 可恢复
    const { loadMessages } = await import('../src/session/employee-session.js');
    const msgs = await loadMessages(await new EmployeeSessionStore(sessionRoot).open(pkg.taskId));
    expect(JSON.stringify(msgs.at(-1))).toContain('自测通过');
  });
});
