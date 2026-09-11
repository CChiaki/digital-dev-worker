import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTaskPackage, type EmployeeProfile } from '@ddw/runtime';
import { FileEventStore } from '../src/stores/index.js';
import { CheckReviewQueue } from '../src/team/review-gate.js';
import { createProcessExecutor } from '../src/team/process-executor.js';
import type { WorkerJob } from '../src/team/worker.js';

/**
 * P13-T2 进程执行器单测（真 fork 子进程）：done 回传 + 事件回流主 store（hash 链保序）、
 * shadow 闸门跨进程闭环（gate-wait → 主队列 review → verdict 回传 → 放行 → done）、
 * worker 崩溃（exit）与报错（error IPC）→ 保守 outcome（failed/blocked 传播入口）。
 * fork 目标为真 worker.ts（node 26 原生 TS 直跑），agent 用 fixture faux 注入。
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAUX_AGENT = join(FIXTURES, 'faux-agent.mjs');
const CRASH_WORKER = join(FIXTURES, 'crash-worker.mjs');

const YAML = `
taskId: P13-PE/1
title: 进程执行器任务
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
tasks: [{ id: T-1, title: t, files: [src/main.js], requirement: r, acceptance: [a] }]
`;

const shadow: EmployeeProfile = { id: 'emp-pe', name: '小程', role: 'backend', skills: ['backend'], supervision: { level: 'shadow' } };
const assisted: EmployeeProfile = { ...shadow, id: 'emp-pe2', supervision: { level: 'assisted' } };

let root: string;
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function setup() {
  root ??= await mkdtemp(join(tmpdir(), 'ddw-pexec-'));
  const events = new FileEventStore(join(root, `data-${Math.random().toString(36).slice(2, 8)}`));
  return { events, queue: new CheckReviewQueue() };
}

function configFor(root2: string, over: Partial<WorkerJob['config']> = {}): WorkerJob['config'] {
  return {
    routes: [{ callType: 'code', primary: { name: 'glm', baseUrl: 'http://model-cluster.inner.bank/v1', apiKey: 'k', model: 'glm-5.3-flash' } }],
    backendKind: 'noop',
    workspaceRoot: join(root2, 'ws'),
    sessionsRoot: join(root2, 'sess'),
    agentModulePath: FAUX_AGENT,
    skipWorkspacePrepare: true, // faux 场景无真实仓库
    ...over,
  };
}

async function waitFor(pred: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`等待 ${what} 超时`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('team/process-executor（P13 fork 执行器）', () => {
  it('done 回传 + 事件回流主 store（assisted 直通）', { timeout: 30_000 }, async () => {
    const { events, queue } = await setup();
    const exec = createProcessExecutor({ config: configFor(root), events, reviewQueue: queue });
    const task = parseTaskPackage(YAML);

    const outcome = await exec({ task, employee: assisted });
    expect(outcome.status).toBe('done');
    expect(outcome.reply).toContain('worker 伪执行完成');

    // 事件在主进程侧落库（worker 不写 store）
    const all = await events.list();
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) expect(e.taskId).toBe('P13-PE/1');
    expect(all.some((e) => e.type === 'task_check')).toBe(true);
    expect(all.some((e) => e.type === 'report')).toBe(true);
  });

  it('shadow 闸门跨进程闭环：待审可见 → 放行 → verdict 回传 → done', { timeout: 30_000 }, async () => {
    const { events, queue } = await setup();
    const exec = createProcessExecutor({ config: configFor(root), events, reviewQueue: queue });
    const task = parseTaskPackage(YAML);

    const pending = exec({ task, employee: shadow });
    // 申报事件回流即代表 gate-wait 已挂到主队列（worker 先注册等待再发事件，P10 竞态修复同序）
    await waitFor(async () => {
      const all = await events.list();
      return all.some((e) => e.type === 'task_check' && (e.payload as { awaiting?: boolean }).awaiting === true);
    }, 'task_check awaiting 事件回流');
    expect(() => queue.review('P13-PE/1', 'T-1', true)).not.toThrow();

    const outcome = await pending;
    expect(outcome.status).toBe('done');
    const all = await events.list();
    expect(all.some((e) => e.type === 'intervention' && (e.payload as { approved?: boolean }).approved === true)).toBe(true);
  });

  it('worker 崩溃（非零 exit）→ 保守 outcome，不抛异常', { timeout: 30_000 }, async () => {
    const { events, queue } = await setup();
    const errors: string[] = [];
    const exec = createProcessExecutor({
      config: configFor(root), events, reviewQueue: queue,
      workerPath: CRASH_WORKER, onWorkerError: (m) => errors.push(m),
    });
    const outcome = await exec({ task: parseTaskPackage(YAML), employee: assisted });
    expect(outcome).toEqual({ status: 'max_turns', reply: expect.stringContaining('exit code=2'), turns: 0 });
    expect(errors.length).toBe(1);
  });

  it('worker 报错（error IPC，坏 agent 模块）→ 保守 outcome', { timeout: 30_000 }, async () => {
    const { events, queue } = await setup();
    const errors: string[] = [];
    const exec = createProcessExecutor({
      config: configFor(root, { agentModulePath: '/nonexistent/ddw-faux.mjs' }), events, reviewQueue: queue,
      onWorkerError: (m) => errors.push(m),
    });
    const outcome = await exec({ task: parseTaskPackage(YAML), employee: assisted });
    expect(outcome.status).toBe('max_turns');
    expect(outcome.reply).toContain('执行进程异常退出');
    expect(errors.length).toBe(1);
  });
});
