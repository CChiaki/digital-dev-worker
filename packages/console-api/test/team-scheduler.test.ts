import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTaskStore, FileEventStore } from '../src/stores/index.js';
import type { TaskStore, EventStore } from '../src/stores/index.js';
import { TeamScheduler } from '../src/team/scheduler.js';
import type { TeamSchedulerDeps } from '../src/team/scheduler.js';
import { EmployeeRoster, parseTaskPackage } from '@ddw/runtime';
import type { EmployeeProfile, EmployeeOutcome, TaskPackage } from '@ddw/runtime';
import type { EmployeeExecutor } from '../src/team/executor.js';

let dir: string;
let tasks: TaskStore;
let events: EventStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ddw-team-sched-'));
  tasks = new FileTaskStore(dir);
  events = new FileEventStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const YAML = (taskId: string, opts: { role?: string; dependsOn?: string[]; assignee?: string } = {}): string => `
taskId: ${taskId}
title: 任务 ${taskId}
role: ${opts.role ?? ''}
${opts.assignee ? `assignee: ${opts.assignee}\n` : ''}dependsOn:
${(opts.dependsOn ?? ['__none__']).map((d) => `  - ${d}`).join('\n')}
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
tasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]
`.replace('role: \n', '').replace('dependsOn:\n  - __none__\n', '');

const add = async (taskId: string, opts: { role?: string; dependsOn?: string[]; assignee?: string } = {}): Promise<TaskPackage> => {
  const pkg = parseTaskPackage(YAML(taskId, opts));
  await tasks.add(pkg);
  return pkg;
};

const emp = (id: string, skills: string[]): EmployeeProfile => ({ id, name: `员工${id}`, role: skills[0]!, skills });

const okOutcome = (taskId: string): EmployeeOutcome => ({ status: 'done', reply: `ok:${taskId}`, turns: 1 });

/** fake executor：可配置延迟模拟并行、可指定失败 */
function fakeExecutor(opts: { delayMs?: number; fail?: (taskId: string) => boolean; throws?: (taskId: string) => boolean } = {}): EmployeeExecutor & { ran: string[] } {
  const ran: string[] = [];
  const fn = async ({ task }: { task: TaskPackage }) => {
    ran.push(task.taskId);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.throws?.(task.taskId)) throw new Error('执行炸了');
    return okOutcome(task.taskId);
  };
  return Object.assign(fn, { ran, fail: opts.fail });
}

async function makeScheduler(
  profiles: EmployeeProfile[],
  executor: EmployeeExecutor,
  over: Partial<Pick<TeamSchedulerDeps, 'awaitCompletion' | 'taskTimeoutMs' | 'pendingChecksOf'>> = {},
): Promise<TeamScheduler> {
  return new TeamScheduler({ tasks, events, roster: new EmployeeRoster(profiles), executor, ...over });
}

const schedEvents = async (): Promise<string[]> =>
  (await events.list({ type: 'dispatch' })).map((e) => e.summary);

describe('TeamScheduler（班组调度器）', () => {
  it('awaitCompletion=false（生产语义）：tick 只分派立即返回，不等执行完成（P10 人工放行不拖死调度）', async () => {
    const exec = fakeExecutor({ delayMs: 150 });
    const sched = await makeScheduler([emp('emp-01', ['backend'])], exec, { awaitCompletion: false });
    const a = await add('TASK-A', { role: 'backend' });

    const t0 = Date.now();
    expect(await sched.tick()).toBe(1); // 分派数立即返回
    expect(Date.now() - t0).toBeLessThan(100); // 没等 executor 的 150ms
    expect((await tasks.get(a.taskId))!.status).toBe('running'); // 执行中

    // 后续 tick 不被阻塞，可继续分派新任务
    const b = await add('TASK-B', { role: 'backend' });
    expect(await sched.tick()).toBe(0); // emp-01 忙，B 分派不出去（waiting）
    await new Promise((r) => setTimeout(r, 200)); // 等 A 落定
    expect((await tasks.get(a.taskId))!.status).toBe('done');
    expect(await sched.tick()).toBe(1); // A done 归还员工，B 分派
    await new Promise((r) => setTimeout(r, 200));
    expect((await tasks.get(b.taskId))!.status).toBe('done');
  });

  it('无依赖任务并行分派：一次 tick 全部执行完，员工归还', async () => {
    const exec = fakeExecutor({ delayMs: 20 });
    const sched = await makeScheduler([emp('emp-01', ['frontend']), emp('emp-02', ['backend'])], exec);
    const a = await add('TASK-A', { role: 'frontend' });
    const b = await add('TASK-B', { role: 'backend' });

    const n = await sched.tick();
    expect(n).toBe(2);
    expect(exec.ran).toEqual(['TASK-A', 'TASK-B']); // 都分派了
    expect((await tasks.get(a.taskId))!.status).toBe('done');
    expect((await tasks.get(b.taskId))!.status).toBe('done');
    const evs = await schedEvents();
    // 分派序确定（tick 内同步推入）；两个并行执行体的完成事件 append 序随机，只比对集合
    expect(evs.slice(0, 2)).toEqual([
      '分派任务 TASK-A → emp-01（员工emp-01）',
      '分派任务 TASK-B → emp-02（员工emp-02）',
    ]);
    expect(evs.slice(2).sort()).toEqual([
      '任务 TASK-A 完成（emp-01）',
      '任务 TASK-B 完成（emp-02）',
    ].sort());
  });

  it('依赖链：B dependsOn A —— 第一轮只跑 A，A done 后第二轮 B 就绪', async () => {
    const exec = fakeExecutor();
    const sched = await makeScheduler([emp('emp-01', ['backend'])], exec);
    const a = await add('TASK-A');
    const b = await add('TASK-B', { dependsOn: ['TASK-A'] });

    await sched.tick(); // A 分派完成；B waiting
    expect(exec.ran).toEqual(['TASK-A']);
    expect((await tasks.get(a.taskId))!.status).toBe('done');
    expect((await tasks.get(b.taskId))!.status).toBe('pending');

    await sched.tick(); // B 就绪
    expect(exec.ran).toEqual(['TASK-A', 'TASK-B']);
    expect((await tasks.get(b.taskId))!.status).toBe('done');
    expect((await events.list({ taskId: 'TASK-B', type: 'dispatch' })).map((e) => e.summary)).toEqual([
      'waiting: 等待上游任务: TASK-A（pending）',
      '分派任务 TASK-B → emp-01（员工emp-01）',
      '任务 TASK-B 完成（emp-01）',
    ]);
  });

  it('上游 failed → 下游 blocked 不再自动分派；waiting 留痕去重', async () => {
    const exec = fakeExecutor({ throws: () => true });
    const sched = await makeScheduler([emp('emp-01', ['backend'])], exec);
    const a = await add('TASK-A');
    const b = await add('TASK-B', { dependsOn: ['TASK-A'] });

    await sched.tick(); // A 执行抛错 → failed
    expect((await tasks.get(a.taskId))!.status).toBe('failed');
    expect((await tasks.get(a.taskId))!.result?.reply).toContain('执行炸了');

    await sched.tick();
    await sched.tick(); // 多轮 tick，blocked 只留痕一次
    expect((await tasks.get(b.taskId))!.status).toBe('pending'); // 保持在池中
    const blockedNotes = (await events.list({ type: 'dispatch' })).filter((e) => e.summary.startsWith('blocked'));
    expect(blockedNotes).toHaveLength(1);
    expect(blockedNotes[0]!.summary).toContain('上游任务失败: TASK-A');
  });

  it('依赖不存在的 taskId → blocked', async () => {
    const exec = fakeExecutor();
    const sched = await makeScheduler([emp('emp-01', ['backend'])], exec);
    await add('TASK-B', { dependsOn: ['TASK-GHOST'] });
    await sched.tick();
    expect(exec.ran).toEqual([]);
    expect(await schedEvents()).toEqual(['blocked: 依赖的任务包不存在: TASK-GHOST']);
  });

  it('seedNotes（2026-09-11 用户复盘批）：重启后回放 blocked/waiting 留痕，状态未变不重复记', async () => {
    const exec = fakeExecutor({ throws: (id) => id === 'TASK-A' });
    await add('TASK-A');
    await add('TASK-B', { dependsOn: ['TASK-A'] });
    // 第一代进程：A failed → B blocked 留痕一条（首轮 B 只能 waiting——A 尚 pending，二轮才 blocked）
    const first = await makeScheduler([emp('emp-01', ['backend'])], exec);
    await first.tick();
    await first.tick();
    const countBlocked = async (): Promise<number> =>
      (await events.list({ type: 'dispatch' })).filter((e) => e.summary.startsWith('blocked')).length;
    expect(await countBlocked()).toBe(1);

    // 模拟重启：第二代调度器内存缓存为空——先 seedNotes 再 tick，状态没变不重复留痕
    const second = await makeScheduler([], exec);
    await second.seedNotes();
    expect(await second.tick()).toBe(0); // B 仍 blocked
    expect(await countBlocked()).toBe(1);

    // 对照：不播种（旧行为）首轮 tick 会多记一条
    const third = await makeScheduler([], exec);
    await third.tick();
    expect(await countBlocked()).toBe(2);
  });

  it('岗位无空闲匹配 → 留在池中；员工空出来后下一轮分派', async () => {
    const exec = fakeExecutor();
    const sched = await makeScheduler([emp('emp-01', ['backend'])], exec);
    await add('TASK-FE', { role: 'frontend' });
    await add('TASK-BE', { role: 'backend' });

    await sched.tick(); // frontend 无人 → waiting；backend 分派
    expect(exec.ran).toEqual(['TASK-BE']);

    // emp-01 释放后扩一个 frontend 员工（新 roster 模拟员工空闲）
    const sched2 = new TeamScheduler({
      tasks, events,
      roster: new EmployeeRoster([emp('emp-01', ['backend']), emp('emp-02', ['frontend'])]),
      executor: exec,
    });
    await sched2.tick();
    expect(exec.ran).toEqual(['TASK-BE', 'TASK-FE']);
  });

  it('assignee 点名分派：忽略 role（员工 skills 不含 pkg.role 也接单）', async () => {
    const exec = fakeExecutor();
    const sched = await makeScheduler([emp('emp-01', ['dev'])], exec);
    const a = await add('TASK-A', { role: 'ui', assignee: 'emp-01' }); // ui 不在 emp-01 skills

    expect(await sched.tick()).toBe(1);
    expect(exec.ran).toEqual(['TASK-A']);
    expect((await tasks.get(a.taskId))!.status).toBe('done');
    expect((await events.list({ type: 'dispatch' })).map((e) => e.summary)).toContain(
      '分派任务 TASK-A → emp-01（员工emp-01）',
    );
  });

  it('指定员工正忙 → 留池留痕「正忙，完成后自动分派」，释放后下一 tick 分派', async () => {
    const exec = fakeExecutor({ delayMs: 100 });
    const sched = await makeScheduler([emp('emp-01', ['dev'])], exec, { awaitCompletion: false });
    await add('TASK-A', { assignee: 'emp-01' });
    const b = await add('TASK-B', { assignee: 'emp-01' });

    expect(await sched.tick()).toBe(1); // A 点名 emp-01
    expect(await sched.tick()).toBe(0); // emp-01 忙：B 留池留痕
    expect((await tasks.get(b.taskId))!.status).toBe('pending');
    expect(await schedEvents()).toContain('waiting: 指定员工 emp-01 正忙，完成后自动分派');

    await new Promise((r) => setTimeout(r, 200)); // A 落定，emp-01 释放
    expect(await sched.tick()).toBe(1); // 下一 tick B 点名成功
    await new Promise((r) => setTimeout(r, 200));
    expect((await tasks.get(b.taskId))!.status).toBe('done');
  });

  it('指定员工不存在 → 留痕「指定员工不可用（x），等人工处理」，任务留池', async () => {
    const exec = fakeExecutor();
    const sched = await makeScheduler([emp('emp-01', ['dev'])], exec);
    const t = await add('TASK-A', { assignee: 'ghost' });

    await sched.tick();
    await sched.tick(); // 多轮 tick：waiting 留痕去重只记一次
    expect(exec.ran).toEqual([]);
    expect((await tasks.get(t.taskId))!.status).toBe('pending');
    const notes = (await events.list({ type: 'dispatch' })).filter((e) => e.summary.startsWith('waiting'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.summary).toBe('waiting: 指定员工不可用（ghost），等人工处理');
  });

  it('指定 + dependsOn 组合：依赖未 done 不点名（readiness 先于分派），依赖 done 后再点名', async () => {
    const exec = fakeExecutor();
    const sched = await makeScheduler([emp('emp-01', ['dev'])], exec);
    const a = await add('TASK-A', { assignee: 'emp-01' });
    const b = await add('TASK-B', { assignee: 'emp-01', dependsOn: ['TASK-A'] });

    await sched.tick(); // A 点名分派；B 依赖未 done → waiting 上游，不点名
    expect(exec.ran).toEqual(['TASK-A']);
    expect((await tasks.get(b.taskId))!.status).toBe('pending');
    expect((await events.list({ taskId: 'TASK-B', type: 'dispatch' })).map((e) => e.summary))
      .toEqual(['waiting: 等待上游任务: TASK-A（pending）']);

    await sched.tick(); // A done → B 点名 emp-01
    expect(exec.ran).toEqual(['TASK-A', 'TASK-B']);
    expect((await tasks.get(b.taskId))!.status).toBe('done');
  });

  it('assignee 带前后空白：消费侧 trim 后点名（T1 Minor① 兜底：存值未 trim）', async () => {
    const exec = fakeExecutor();
    const sched = await makeScheduler([emp('emp-01', ['dev'])], exec);
    const pkg = parseTaskPackage(YAML('TASK-A'));
    pkg.assignee = '  emp-01  '; // 模拟 T1 未 trim 的存值
    await tasks.add(pkg);

    expect(await sched.tick()).toBe(1);
    expect(exec.ran).toEqual(['TASK-A']);
    expect((await tasks.get(pkg.taskId))!.status).toBe('done');
  });

  it('任务包 role 带前后空白：消费侧 trim 后仍匹配岗位（T3 档案卫生：存值未 trim 兜底）', async () => {
    const exec = fakeExecutor();
    const sched = await makeScheduler([emp('emp-01', ['backend'])], exec);
    const pkg = parseTaskPackage(YAML('TASK-A', { role: 'backend' }));
    pkg.role = ' backend '; // 模拟存值带空白（yaml/HTTP 写入未归一）
    await tasks.add(pkg);

    expect(await sched.tick()).toBe(1);
    expect(exec.ran).toEqual(['TASK-A']);
    expect((await tasks.get(pkg.taskId))!.status).toBe('done');
  });

  it('无 role 的任务包任意空闲员工可接；员工不足时分轮执行', async () => {
    const exec = fakeExecutor();
    const sched = await makeScheduler([emp('emp-01', ['backend'])], exec);
    await add('TASK-A');
    await add('TASK-B');

    await sched.tick(); // 只有 1 个员工：本轮分派 1 个
    expect(exec.ran.length).toBe(1);
    await sched.tick();
    expect(exec.ran.length).toBe(2);
    expect(exec.ran[0]).toBe('TASK-A');
  });

  it('并发 tick 不会重复分派同一任务（inFlight + claim 原子）', async () => {
    const exec = fakeExecutor({ delayMs: 30 });
    const sched = await makeScheduler([emp('emp-01', ['backend']), emp('emp-02', ['backend'])], exec);
    await add('TASK-A', { role: 'backend' });

    const [n1, n2] = await Promise.all([sched.tick(), sched.tick()]);
    expect(n1 + n2).toBe(1); // 只分派一次
    expect(exec.ran).toEqual(['TASK-A']);
    expect((await events.list({ type: 'dispatch' })).filter((e) => e.summary.startsWith('分派'))).toHaveLength(1);
  });

  it('调度器 finish 透传 planProgress/failedItemId；续跑任务重新分派时 executor 收到 progress（2026-09-05 计划模式）', async () => {
    const PLAN_YAML = `
taskId: TASK-PLAN-R
title: 计划续跑任务
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
plan:
  - id: t1
    title: 开发
    detail: d1
  - id: t2
    kind: test
    title: 测试
    detail: d2
`;
    const pkg = parseTaskPackage(PLAN_YAML);
    await tasks.add(pkg);
    const taskId = pkg.taskId;

    // faux executor 记录入参；第一轮让 t2 失败（链停语义：failedItemId='t2'）
    const received: { progress?: unknown; employeeId?: string }[] = [];
    let call = 0;
    const planExec: EmployeeExecutor = async ({ task, employee, progress }) => {
      received.push({ progress, employeeId: employee.id });
      call++;
      if (call === 1) {
        return {
          status: 'done', reply: '计划停在第 2 项', turns: 0,
          planProgress: [
            { itemId: 't1', kind: 'dev', title: '开发', status: 'done' },
            { itemId: 't2', kind: 'test', title: '测试', status: 'failed' },
          ],
          failedItemId: 't2',
        };
      }
      return {
        status: 'done', reply: '计划全部完成', turns: 0,
        planProgress: [
          { itemId: 't1', kind: 'dev', title: '开发', status: 'done' },
          { itemId: 't2', kind: 'test', title: '测试', status: 'done' },
        ],
      };
    };

    const sched = await makeScheduler([emp('emp-01', ['dev'])], planExec);
    await sched.tick(); // 第一轮：t1 done、t2 failed → 任务 failed，进度与停点落库
    expect(call).toBe(1);
    const failed = await tasks.get(taskId);
    expect(failed!.status).toBe('failed');
    expect(failed!.failedItemId).toBe('t2');
    expect(failed!.planProgress!.map((p) => [p.itemId, p.status])).toEqual([['t1', 'done'], ['t2', 'failed']]);

    // resume 续跑 → pending（保留 progress、失败项复位 skipped、清停点），重新分派时 executor 收到 progress
    await tasks.resumePlan(taskId);
    await sched.tick();
    expect(call).toBe(2);
    // t1 done 不重做（由 runner 用例保证，此处验接线）；t2 失败项已复位 skipped 供重跑（2026-09-06）
    expect(received[1]!.progress).toEqual([
      { itemId: 't1', kind: 'dev', title: '开发', status: 'done' },
      { itemId: 't2', kind: 'test', title: '测试', status: 'skipped' },
    ]);
    // 谁失败谁继续（2026-09-06 用户语义）：续跑点名原执行员工 emp-01（acquireById），非岗位自动分派
    expect(received[1]!.employeeId).toBe('emp-01');
    const done = await tasks.get(taskId);
    expect(done!.status).toBe('done');
    expect(done!.failedItemId).toBeUndefined();
    expect(done!.planProgress!.map((p) => p.status)).toEqual(['done', 'done']);
  });

  it('onTaskComplete：任务成功完成触发一次，失败不触发，回调异常不炸 tick（2026-09-06 蒸馏钩子）', async () => {
    // 成功路径：ok=true → 触发一次（入参 = 任务包 + 员工档案）
    const calls: string[] = [];
    const sched = new TeamScheduler({
      tasks, events, roster: new EmployeeRoster([emp('emp-01', ['backend'])]),
      executor: fakeExecutor(),
      onTaskComplete: async (task, employee) => { calls.push(`${task.taskId}:${employee.id}`); },
    });
    const a = await add('TASK-A', { role: 'backend' });
    await sched.tick();
    await new Promise((r) => setTimeout(r, 20)); // 钩子 fire-and-forget：等微任务落定再断言
    expect(calls).toEqual(['TASK-A:emp-01']);
    expect((await tasks.get(a.taskId))!.status).toBe('done');

    // 失败路径：executor 抛错 → ok=false → 不触发
    const failedCalls: string[] = [];
    const failSched = new TeamScheduler({
      tasks, events, roster: new EmployeeRoster([emp('emp-01', ['backend'])]),
      executor: fakeExecutor({ throws: () => true }),
      onTaskComplete: async (task) => { failedCalls.push(task.taskId); },
    });
    const b = await add('TASK-B', { role: 'backend' });
    await failSched.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect((await tasks.get(b.taskId))!.status).toBe('failed');
    expect(failedCalls).toEqual([]);

    // 回调内部抛异常：只 console.error，不得炸 tick（tick 正常返回 + 任务正常 done）
    const boomSched = new TeamScheduler({
      tasks, events, roster: new EmployeeRoster([emp('emp-01', ['backend'])]),
      executor: fakeExecutor(),
      onTaskComplete: async () => { throw new Error('蒸馏炸了'); },
    });
    const c = await add('TASK-C', { role: 'backend' });
    await expect(boomSched.tick()).resolves.toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect((await tasks.get(c.taskId))!.status).toBe('done');
  });
});

describe('任务看门狗 + 强制重置（2026-09-11 P0 韧性批）', () => {
  /** awaitCompletion=false 下 tick 返回不等于执行落定——终态断言用轮询等待（fs 落盘竞态，仓库惯例） */
  const waitStatus = async (taskId: string, want: string, timeoutMs = 2_000): Promise<void> => {
    for (let i = 0; i < timeoutMs / 20 && (await tasks.get(taskId))?.status !== want; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('running 超 taskTimeoutMs → 收割 failed「任务超时」+ 释放员工；迟到回写被守卫丢弃；重置后可重新执行', async () => {
    let call = 0;
    const exec: EmployeeExecutor = async ({ task }) => {
      call++;
      if (call === 1) await new Promise((r) => setTimeout(r, 350)); // 第一轮模拟模型 hang（超看门狗时长）
      return okOutcome(task.taskId);
    };
    const sched = await makeScheduler([emp('emp-01', ['backend'])], exec, { awaitCompletion: false, taskTimeoutMs: 80 });
    const a = await add('TASK-A', { role: 'backend' });

    expect(await sched.tick()).toBe(1); // 分派，executor 开始 hang
    await new Promise((r) => setTimeout(r, 150)); // 超过 80ms 看门狗时限

    // 收割：failed + 超时话术 + 员工释放（TASK-B 立即可分派给同一员工）
    expect(await sched.watchdogSweep()).toBe(1);
    const reaped = await tasks.get(a.taskId);
    expect(reaped!.status).toBe('failed');
    expect(reaped!.result?.reply).toContain('任务超时');
    const b = await add('TASK-B', { role: 'backend' });
    expect(await sched.tick()).toBe(1); // emp-01 已释放，B 分派成功（executor 第 2 次调用，快速返回）
    await waitStatus(b.taskId, 'done');

    // 迟到回写守卫：hang 的第一轮 350ms 后返回——不得覆盖收割态、不得重复释放员工
    await new Promise((r) => setTimeout(r, 250));
    expect(call).toBe(2); // 第一轮已返回（被丢弃），第二轮 B 已完成
    const still = await tasks.get(a.taskId);
    expect(still!.status).toBe('failed'); // 仍是收割态，未被 done 覆盖
    expect(still!.result?.reply).toContain('任务超时');
    expect(await schedEvents()).toContain('任务 TASK-A 执行结果迟到（已被收割/重置），丢弃回写');

    // 崩溃恢复闭环：强制重置回 pending → 重新分派执行（收割标记随之失效）
    await tasks.resetToPending(a.taskId);
    expect(await sched.tick()).toBe(1);
    expect(call).toBe(3); // 第三次调用（不再 hang）
    await waitStatus(a.taskId, 'done');
    expect((await tasks.get(a.taskId))!.status).toBe('done');
  });

  it('挂审待放行 4 倍宽限：等人工放行不是 hang，不误杀（2026-09-11 P0 韧性批核心语义）', async () => {
    const exec = fakeExecutor({ delayMs: 10_000 }); // 挂起等放行（长阻塞不返回）
    // pendingChecksOf 永远报告 TASK-A 挂审中（模拟 listPendingChecks 命中）
    const sched = await makeScheduler([emp('emp-01', ['backend'])], exec, {
      awaitCompletion: false,
      taskTimeoutMs: 150,
      pendingChecksOf: async () => [{ taskId: 'TASK-A' }],
    });
    const a = await add('TASK-A', { role: 'backend' });

    expect(await sched.tick()).toBe(1);
    await new Promise((r) => setTimeout(r, 250)); // 超 1 倍时限但仍在 4 倍（600ms）宽限内
    expect(await sched.watchdogSweep()).toBe(0); // 挂审：不收割
    expect((await tasks.get(a.taskId))!.status).toBe('running');

    await new Promise((r) => setTimeout(r, 400)); // 累计 ≥650ms > 4×150ms 宽限耗尽
    expect(await sched.watchdogSweep()).toBe(1); // 超宽限仍无人处理 → 收割
    expect((await tasks.get(a.taskId))!.status).toBe('failed');
    expect((await tasks.get(a.taskId))!.result?.reply).toContain('任务超时');
  });

  it('未配置 taskTimeoutMs → 看门狗关闭（watchdogSweep 恒 0，零回归缺省语义）', async () => {
    const sched = await makeScheduler([emp('emp-01', ['backend'])], fakeExecutor());
    const a = await add('TASK-A', { role: 'backend' });
    await sched.tick();
    expect(await sched.watchdogSweep()).toBe(0);
    expect((await tasks.get(a.taskId))!.status).toBe('done');
  });
});
