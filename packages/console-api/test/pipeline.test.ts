import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileTaskStore, FileEventStore } from '../src/stores/index.js';
import type { TaskStore, EventStore } from '../src/stores/index.js';
import { createRuntimePipeline, defaultToolsFor } from '../src/team/pipeline.js';
import { parseTaskPackage, EmployeeRoster } from '@ddw/runtime';
import type { EmployeeOutcome, EmployeeProfile, TaskPackage, ToolRegistry } from '@ddw/runtime';

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const YAML = (taskId: string): string => `
taskId: ${taskId}
title: 任务 ${taskId}
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
tasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]
`;

const emp = (id: string, skills: string[]): EmployeeProfile => ({ id, name: `员工${id}`, role: skills[0]!, skills });

describe('createRuntimePipeline（一体化装配，P9-T1）', () => {
  it('装配依赖注入正确：faux executor 手动 tick 分派，事件同源落库', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-pipeline-'));
    const tasks: TaskStore = new FileTaskStore(dir);
    const events: EventStore = new FileEventStore(dir);
    const ran: string[] = [];
    const executor = async ({ task }: { task: TaskPackage }): Promise<EmployeeOutcome> => {
      ran.push(task.taskId);
      return { status: 'done', reply: `ok:${task.taskId}`, turns: 1 };
    };

    const pipeline = createRuntimePipeline(
      { tasks, events },
      {
        profiles: [emp('emp-01', ['backend']), emp('emp-02', ['frontend'])],
        workspaceRoot: join(dir, 'ws'),
        sessionsRoot: join(dir, 'sessions'),
        routes: [], // faux executor 不触达 gateway
        executor,
      },
    );
    expect(pipeline.scheduler).toBeInstanceOf(Object);

    await tasks.add(parseTaskPackage(YAML('TASK-A')));
    await tasks.add(parseTaskPackage(YAML('TASK-B')));
    expect(await pipeline.scheduler.tick()).toBe(2);
    expect(ran.sort()).toEqual(['TASK-A', 'TASK-B']);
    expect((await tasks.get('TASK-A'))!.status).toBe('done');
    // 调度事件留痕（直播/审计同源）
    const dispatches = (await events.list({ type: 'dispatch' })).map((e) => e.summary);
    expect(dispatches).toContain('分派任务 TASK-A → emp-01（员工emp-01）');
  });

  it('start() 定时自动分派、stop() 停止；重复 start 幂等', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-pipeline-auto-'));
    const tasks: TaskStore = new FileTaskStore(dir);
    const events: EventStore = new FileEventStore(dir);
    let runs = 0;
    const pipeline = createRuntimePipeline(
      { tasks, events },
      {
        profiles: [emp('emp-01', ['backend'])],
        tickIntervalMs: 15,
        workspaceRoot: join(dir, 'ws'),
        sessionsRoot: join(dir, 'sessions'),
        routes: [],
        executor: async () => {
          runs++;
          return { status: 'done', reply: 'ok', turns: 1 };
        },
      },
    );
    await tasks.add(parseTaskPackage(YAML('TASK-AUTO')));

    pipeline.start();
    pipeline.start(); // 幂等：不重复起定时器
    await new Promise((r) => setTimeout(r, 120));
    pipeline.stop();
    const runsAtStop = runs;
    expect(runsAtStop).toBeGreaterThanOrEqual(1);
    expect((await tasks.get('TASK-AUTO'))!.status).toBe('done');
    await new Promise((r) => setTimeout(r, 60));
    expect(runs).toBe(runsAtStop); // stop 后不再 tick
  });

  it('defaultToolsFor：工作区编码工具 + 受控 bash 就位', () => {
    const tools: ToolRegistry = defaultToolsFor('/tmp/ddw-ws-x');
    const names = tools.list().map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('run_cmd');
  });

  it('profiles 重复 id 装配即抛错（名册校验前置）', () => {
    dir = dir ?? '';
    expect(() =>
      createRuntimePipeline(
        { tasks: new FileTaskStore('/tmp/ddw-pipeline-roster'), events: new FileEventStore('/tmp/ddw-pipeline-roster') },
        {
          profiles: [emp('emp-01', ['backend']), emp('emp-01', ['frontend'])],
          workspaceRoot: '/tmp/ddw-pipeline-ws',
          sessionsRoot: '/tmp/ddw-pipeline-sess',
          routes: [],
        },
      ),
    ).toThrow();
  });

  it('canDispatch：员工能力过滤——绑定外的员工跳过，任务留池 waiting', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-pipeline-cap-'));
    const tasks: TaskStore = new FileTaskStore(dir);
    const events: EventStore = new FileEventStore(dir);
    let ran = 0;
    const pipeline = createRuntimePipeline(
      { tasks, events },
      {
        profiles: [emp('emp-01', ['backend'])],
        workspaceRoot: join(dir, 'ws'),
        sessionsRoot: join(dir, 'sessions'),
        routes: [], // faux executor 不触达 gateway
        // 内存名册：acquire 只回 emp-b，且如实执行 extra 谓词（与 EmployeeRoster/ManagedRoster 语义一致）
        roster: {
          acquire: (role, extra) => {
            const p = emp('emp-b', ['backend']);
            return role && !p.skills.includes(role) ? null : extra && !extra(p) ? null : p;
          },
          acquireById: (id) => (id === 'emp-b' ? emp('emp-b', ['backend']) : null),
          isKnown: (id) => id === 'emp-b',
          release: () => {},
        },
        canDispatch: () => false,
        executor: async () => {
          ran++;
          return { status: 'done', reply: 'ok', turns: 1 };
        },
      },
    );

    await tasks.add(parseTaskPackage(YAML('TASK-CAP')));
    expect(await pipeline.scheduler.tick()).toBe(0);
    expect(ran).toBe(0); // executor 未被调用
    expect((await tasks.get('TASK-CAP'))!.status).toBe('pending'); // 任务留池
    // 统一 waiting 留痕（与「无空闲员工」同文案，note 去重语义不变）
    const dispatches = (await events.list({ type: 'dispatch' })).map((e) => e.summary);
    expect(dispatches).toContain('waiting: 无空闲员工匹配岗位');
  });

  it('onBeforeTick：每 tick 前调用（档案刷新点）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-pipeline-obt-'));
    const tasks: TaskStore = new FileTaskStore(dir);
    const events: EventStore = new FileEventStore(dir);
    let beforeTicks = 0;
    const pipeline = createRuntimePipeline(
      { tasks, events },
      {
        profiles: [emp('emp-01', ['backend'])],
        tickIntervalMs: 15,
        workspaceRoot: join(dir, 'ws'),
        sessionsRoot: join(dir, 'sessions'),
        routes: [],
        onBeforeTick: async () => {
          beforeTicks++;
        },
        executor: async () => ({ status: 'done', reply: 'ok', turns: 1 }),
      },
    );

    await tasks.add(parseTaskPackage(YAML('TASK-BT')));
    pipeline.start();
    await new Promise((r) => setTimeout(r, 120));
    pipeline.stop();
    expect(beforeTicks).toBeGreaterThanOrEqual(2); // 启动即试一轮 + 定时轮，每 tick 前都调用
    expect((await tasks.get('TASK-BT'))!.status).toBe('done');
  });

  it('execMode fork 装配 smoke：手动 tick 分派 → worker 子进程执行 → 事件回流 → done', { timeout: 30_000 }, async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-pipeline-fork-'));
    const tasks: TaskStore = new FileTaskStore(dir);
    const events: EventStore = new FileEventStore(dir);
    const pipeline = createRuntimePipeline(
      { tasks, events },
      {
        profiles: [emp('emp-01', ['backend'])],
        workspaceRoot: join(dir, 'ws'),
        sessionsRoot: join(dir, 'sessions'),
        routes: [{ callType: 'code', primary: { name: 'glm', baseUrl: 'http://model-cluster.inner.bank/v1', apiKey: 'k', model: 'glm-5.3-flash' } }],
        execMode: 'fork',
        // faux agent 经 agentModulePath 注入 worker（fork 模式 gateway 注入不可达，走消息携带）
        agentModulePath: join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'faux-agent.mjs'),
      },
    );

    await tasks.add(parseTaskPackage(YAML('TASK-FORK')));
    await pipeline.scheduler.tick();

    // tick 只分派不等完成（P8 语义）——轮询终态：worker 子进程跑完回写 done
    const deadline = Date.now() + 20_000;
    for (;;) {
      const task = await tasks.get('TASK-FORK');
      if (task?.status === 'done') break;
      if (Date.now() > deadline) throw new Error(`等待 TASK-FORK done 超时，当前: ${task?.status}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    // 员工事件经 IPC 回流主 store（worker 不直接写）
    const all = await events.list();
    expect(all.some((e) => e.employeeId === 'emp-01' && e.type === 'report')).toBe(true);
  });
});
