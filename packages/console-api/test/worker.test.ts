import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmployeeSessionStore, loadMessages, parseTaskPackage, type EmployeeProfile } from '@ddw/runtime';
import { CAPABILITY_PRESETS } from '../src/team/capabilities.js';
import { runWorker, type MainToWorker, type WorkerToMain, type WorkerJob } from '../src/team/worker.js';

/**
 * P13-T1 worker 组装单测：runWorker 收 job → 组装（assembleDefaultRuntime 共用）→
 * faux agent（agentModulePath 动态注入）执行 → 事件经 io.send 回传 → done；
 * shadow 级闸门走 gate-wait / gate-verdict IPC 往返；坏模块路径 → error 消息。
 * （不 fork 真子进程——fork 链路由 T2 process-executor 的 e2e 覆盖。）
 */

// 纯绝对路径（file:// URL 会被 vite 的 percent-encoding 解析弄坏；node ESM 下 POSIX 绝对路径等价）
const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'faux-agent.mjs');

const YAML = `
taskId: P13-W/1
title: worker 组装任务
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
tasks: [{ id: T-1, title: t, files: [src/main.js], requirement: r, acceptance: [a] }]
`;

const shadow: EmployeeProfile = { id: 'emp-w', name: '小进', role: 'backend', skills: ['backend'], supervision: { level: 'shadow' } };
const assisted: EmployeeProfile = { ...shadow, id: 'emp-w2', supervision: { level: 'assisted' } };

let root: string;
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function makeIo() {
  const sent: WorkerToMain[] = [];
  let handler: ((m: MainToWorker) => void) | undefined;
  return {
    sent,
    /** 测试手动喂主进程消息（job / gate-verdict） */
    deliver: (m: MainToWorker) => handler?.(m),
    io: {
      send: (m: WorkerToMain) => sent.push(m),
      onMessage: (h: (m: MainToWorker) => void) => { handler = h; },
    },
  };
}

// faux 工厂虽不真用模型，但 makeAgent 会先 gateway.modelFor('code') 解析路由——需有 code 路由
const ROUTES = [{ callType: 'code' as const, primary: { name: 'glm', baseUrl: 'http://model-cluster.inner.bank/v1', apiKey: 'k', model: 'glm-5.3-flash' } }];

function jobFor(employee: EmployeeProfile, over: Partial<WorkerJob['config']> = {}): WorkerJob {
  root ??= '';
  return {
    task: parseTaskPackage(YAML),
    employee,
    config: {
      routes: ROUTES,
      backendKind: 'noop',
      workspaceRoot: join(root, 'ws'),
      sessionsRoot: join(root, 'sess'),
      agentModulePath: FIXTURE_PATH,
      skipWorkspacePrepare: true, // faux 场景无真实仓库
      ...over,
    },
  };
}

async function waitMsg(sent: WorkerToMain[], pred: (m: WorkerToMain) => boolean, what: string): Promise<WorkerToMain> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const hit = sent.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`等待 ${what} 超时`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('team/worker（P13 fork worker 组装）', () => {
  it('shadow 员工一任务跑通：gate-wait → verdict → done，事件回传带 id/ts', async () => {
    root = await mkdtemp(join(tmpdir(), 'ddw-worker-'));
    const { sent, deliver, io } = makeIo();
    runWorker(io);
    deliver({ type: 'job', job: jobFor(shadow) });

    // 申报阻塞：worker 发 gate-wait（taskId 随消息携带，主进程队列按此挂起）
    const gate = await waitMsg(sent, (m) => m.type === 'gate-wait', 'gate-wait');
    if (gate.type !== 'gate-wait') return;
    expect(gate.check).toMatchObject({ taskId: 'P13-W/1', item: 'T-1', passed: true });
    deliver({ type: 'gate-verdict', requestId: gate.requestId, verdict: { approved: true } });

    const done = await waitMsg(sent, (m) => m.type === 'done', 'done');
    if (done.type !== 'done') return;
    expect(done.outcome.status).toBe('done');
    expect(done.outcome.reply).toContain('worker 伪执行完成');

    // 事件经 IPC 回传（落库在主进程侧）：id/ts 已由 emit 填充，task_check 申报 awaiting
    const events = sent.flatMap((m) => (m.type === 'event' ? [m.event] : []));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.id).toBeTruthy();
      expect(e.ts).toBeGreaterThan(0);
      expect(e.taskId).toBe('P13-W/1');
      expect(e.employeeId).toBe('emp-w');
    }
    expect(events.some((e) => e.type === 'task_check' && (e.payload as { awaiting?: boolean }).awaiting === true)).toBe(true);
    expect(events.some((e) => e.type === 'intervention' && (e.payload as { approved?: boolean }).approved === true)).toBe(true);
  });

  it('assisted 员工不阻塞：无 gate-wait 直达 done', async () => {
    root = await mkdtemp(join(tmpdir(), 'ddw-worker-'));
    const { sent, deliver, io } = makeIo();
    runWorker(io);
    deliver({ type: 'job', job: jobFor(assisted) });

    const done = await waitMsg(sent, (m) => m.type === 'done', 'done');
    expect(done.type).toBe('done');
    expect(sent.some((m) => m.type === 'gate-wait')).toBe(false);
  });

  it('agentModulePath 坏路径 → error 消息（主进程据此落 failed 语义）', async () => {
    root = await mkdtemp(join(tmpdir(), 'ddw-worker-'));
    const { sent, deliver, io } = makeIo();
    runWorker(io);
    deliver({ type: 'job', job: jobFor(assisted, { agentModulePath: '/nonexistent/ddw-faux.mjs' }) });

    const err = await waitMsg(sent, (m) => m.type === 'error', 'error');
    if (err.type !== 'error') return;
    expect(err.message).toBeTruthy();
    expect(sent.some((m) => m.type === 'done')).toBe(false);
  });

  it('迟到/未知 requestId 的 gate-verdict 被忽略，不崩溃', async () => {
    root = await mkdtemp(join(tmpdir(), 'ddw-worker-'));
    const { sent, deliver, io } = makeIo();
    runWorker(io);
    expect(() => deliver({ type: 'gate-verdict', requestId: 'no-such', verdict: { approved: true } })).not.toThrow();
  });

  it('从零执行（job 无 progress）清空任务 workspace 与 session 残留；续跑（progress 在场）保留（2026-09-06 任务重跑清空）', async () => {
    const wsDir = join(root, 'ws', 'emp-w2', 'P13-W_1'); // taskId.replaceAll('/', '_')
    const sessRoot = join(root, 'sess', 'emp-w2');

    // 预置上一轮残留：workspace 旧产物 + session 旧上下文
    await mkdir(wsDir, { recursive: true });
    await writeFile(join(wsDir, 'old.js'), '上一轮产物');
    const old = await new EmployeeSessionStore(sessRoot).open('P13-W/1');
    await old.appendMessage({ role: 'user', content: [{ type: 'text', text: '旧上下文' }], timestamp: Date.now() } as never);

    // 从零执行（job 无 progress）：两项全清
    const box1 = makeIo();
    runWorker(box1.io);
    box1.deliver({ type: 'job', job: jobFor(assisted) });
    await vi.waitFor(() => expect(box1.sent.some((m) => m.type === 'done')).toBe(true));
    expect((await readdir(wsDir))).not.toContain('old.js');
    // session 是重建的：旧上下文清除，新会话仅含本轮运行写入的内容（faux 真跑会落简报/回复，
    // 故不能断言 toEqual([])——与 executor 测试的 plan-runner 打桩不同）
    const fresh = await loadMessages(await new EmployeeSessionStore(sessRoot).open('P13-W/1'));
    expect(fresh.some((m) => JSON.stringify(m).includes('旧上下文'))).toBe(false);
    expect(JSON.stringify(fresh)).toContain('任务简报');

    // 断点续跑（progress 在场）：残留全保留
    await writeFile(join(wsDir, 'keep.js'), '续跑产物');
    const cont = await new EmployeeSessionStore(sessRoot).open('P13-W/1');
    await cont.appendMessage({ role: 'user', content: [{ type: 'text', text: '续跑上下文' }], timestamp: Date.now() } as never);
    const box2 = makeIo();
    runWorker(box2.io);
    box2.deliver({
      type: 'job',
      job: {
        ...jobFor(assisted),
        progress: [{ itemId: 'T-1', kind: 'dev', title: 't', status: 'done' as const }],
      },
    });
    await vi.waitFor(() => expect(box2.sent.some((m) => m.type === 'done')).toBe(true));
    expect(await readFile(join(wsDir, 'keep.js'), 'utf8')).toBe('续跑产物');
    expect((await loadMessages(await new EmployeeSessionStore(sessRoot).open('P13-W/1'))).some((m) => JSON.stringify(m).includes('续跑上下文'))).toBe(true);
  });
});

describe('worker skill 快照注入（2026-09-06 fork 链路）', () => {
  // 终审 M4：本 describe 用例结束后清理自己的临时目录（root 与上方 describe 共享模块级变量，
  // afterEach 只在本 describe 作用域触发，不破坏既有 describe 的 fixture）
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('config.skills 随 job 下发：plan 指令含技能段', async () => {
    root = await mkdtemp(join(tmpdir(), 'ddw-worker-skill-'));
    // 录制型 agent 模块（runWorker 在测试同进程动态 import）：把 prompt 收到的指令原文落盘供断言。
    // worker 事件流不含原始 instruction 文本，注入正确性只能靠捕获 agent 的 prompt 入参验证
    const captureFile = join(root, 'captured.txt');
    const modPath = join(root, 'recording-agent.mjs');
    await writeFile(
      modPath,
      [
        'export function agentFactory() {',
        '  return {',
        '    subscribe: () => () => {},',
        `    prompt: async (instruction) => { const fs = await import('node:fs/promises'); await fs.appendFile(${JSON.stringify(captureFile)}, instruction ?? ''); },`,
        '    steer: () => false,',
        '    state: { messages: [] },',
        '  };',
        '}',
      ].join('\n'),
    );
    const { sent, deliver, io } = makeIo();
    runWorker(io);
    deliver({
      type: 'job',
      job: {
        task: {
          taskId: 'P13-FK/1', title: 'fork 注入',
          repo: { url: 'http://gitlab.inner.bank/x.git', branch: 'main' }, tasks: [],
          plan: [{ id: 't1', kind: 'dev', title: '开发', detail: '实现' }],
        },
        employee: { id: 'emp-fk', name: '甲', role: 'backend', skills: [] },
        config: {
          routes: ROUTES,
          backendKind: 'noop',
          workspaceRoot: join(root, 'ws'),
          sessionsRoot: join(root, 'sess'),
          agentModulePath: modPath,
          skipWorkspacePrepare: true, // faux 场景无真实仓库
          capabilities: CAPABILITY_PRESETS.map((d) => ({ ...d })),
          skills: [{
            id: 'skill-f1', categoryId: 'backend', name: 'fork规范', description: '', type: 'knowledge',
            content: 'fork 注入内容', status: 'approved' as const, source: 'manual', createdAt: 1,
          }],
        },
      },
    });

    await waitMsg(sent, (m) => m.type === 'done', 'done');
    // 主断言：携带 skills 的 job 全链路无 error
    expect(sent.some((m) => m.type === 'error')).toBe(false);
    // 录制型 agent 捕获的指令含「技能与约束」段与技能正文（fork 与 inproc 共用 runTaskPlan 同一处注入实现）
    const captured = await readFile(captureFile, 'utf8');
    expect(captured).toContain('## 技能与约束');
    expect(captured).toContain('fork 注入内容');
  }, 20_000);
});
