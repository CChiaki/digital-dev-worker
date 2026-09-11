import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTaskStore, FileEventStore } from '../src/stores/index.js';
import { parseTaskPackage } from '@ddw/runtime';
import { readFile } from 'node:fs/promises';
import type { AgentEvent, TaskPackage } from '@ddw/runtime';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-console-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function samplePkg(taskId: string): Promise<TaskPackage> {
  const yaml = await readFile(
    new URL('../../../examples/task-package.example.yaml', import.meta.url),
    'utf8',
  );
  return { ...parseTaskPackage(yaml), taskId };
}

const ev = (over: Partial<AgentEvent>): AgentEvent => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  ts: 1000,
  taskId: 'TASK-1',
  employeeId: 'emp-01',
  type: 'tool_call',
  summary: 'gitlab_create_branch',
  ...over,
});

describe('TaskStore', () => {
  it('add 落盘 pending；list/get 可读回', async () => {
    const store = new FileTaskStore(root);
    const pkg = await samplePkg('TASK-1');
    const rec = await store.add(pkg);
    expect(rec.status).toBe('pending');

    // 新实例（模拟重启）读回同一任务
    const store2 = new FileTaskStore(root);
    expect(await store2.get('TASK-1')).toMatchObject({ status: 'pending' });
    expect((await store2.list()).map((r) => r.pkg.taskId)).toEqual(['TASK-1']);
    expect(await store2.get('NOPE')).toBeNull();
  });

  it('claim：pending→claimed 记录员工与时间；重复领取抛错', async () => {
    const store = new FileTaskStore(root);
    await store.add(await samplePkg('TASK-1'));

    const rec = await store.claim('TASK-1', 'emp-01');
    expect(rec.status).toBe('claimed');
    expect(rec.claimedBy).toBe('emp-01');
    expect(rec.claimedAt).toBeTypeOf('number');

    await expect(store.claim('TASK-1', 'emp-02')).rejects.toThrow('claimed');
  });

  it('finish：ok=true→done，ok=false→failed，回写 result', async () => {
    const store = new FileTaskStore(root);
    await store.add(await samplePkg('TASK-1'));
    await store.claim('TASK-1', 'emp-01');

    const outcome = { status: 'done' as const, reply: 'MR !42 已创建', turns: 5 };
    const rec = await store.finish('TASK-1', outcome, true);
    expect(rec.status).toBe('done');
    expect(rec.result).toEqual(outcome);

    await store.add(await samplePkg('TASK-2'));
    await store.finish('TASK-2', outcome, false);
    expect((await store.get('TASK-2'))!.status).toBe('failed');
  });

  it('claim/finish 不存在的任务抛错', async () => {
    const store = new FileTaskStore(root);
    await expect(store.claim('NOPE', 'emp-01')).rejects.toThrow();
    await expect(store.finish('NOPE', { status: 'done', reply: '', turns: 1 }, true)).rejects.toThrow();
  });

  it('finish 携带 planProgress/failedItemId 落库；resumePlan 仅 failed 可续（→pending，保留 progress，清停点）', async () => {
    const store = new FileTaskStore(root);
    const pkg = await samplePkg('TASK-1');
    await store.add(pkg);
    await store.claim(pkg.taskId, 'emp-01');
    await store.markRunning(pkg.taskId);
    const progress = [
      { itemId: 't1', kind: 'dev', title: '开发', status: 'done' as const },
      { itemId: 't2', kind: 'test', title: '测试', status: 'failed' as const },
      { itemId: 't3', kind: 'commit', title: '提交', status: 'skipped' as const },
    ];
    await store.finish(pkg.taskId, { status: 'done', reply: '测试未过', turns: 3 }, false, progress, 't2');
    let rec = await store.get(pkg.taskId);
    expect(rec?.planProgress).toEqual(progress);
    expect(rec?.failedItemId).toBe('t2');
    expect(rec?.status).toBe('failed');

    const resumed = await store.resumePlan(pkg.taskId);
    expect(resumed.status).toBe('pending');
    // 保留 done 项（续跑从停点续）；失败项复位 skipped——不残留「失败」标签（2026-09-06 用户反馈）
    expect(resumed.planProgress).toEqual([
      { itemId: 't1', kind: 'dev', title: '开发', status: 'done' },
      { itemId: 't2', kind: 'test', title: '测试', status: 'skipped' },
      { itemId: 't3', kind: 'commit', title: '提交', status: 'skipped' },
    ]);
        expect(resumed.failedItemId).toBeUndefined();
    // 谁失败谁继续（2026-09-06 用户语义）：原执行员工写为 assignee，调度器点名续接
    expect(resumed.pkg.assignee).toBe('emp-01');

    await expect(store.resumePlan(pkg.taskId)).rejects.toThrow(/仅 failed 任务可续跑/);
  });
});

describe('EventStore', () => {
  it('append 写 jsonl；list 按 ts 升序读回', async () => {
    const store = new FileEventStore(root);
    await store.append(ev({ id: 'e1', ts: 2000 }));
    await store.append(ev({ id: 'e2', ts: 1000 }));

    const all = await store.list();
    expect(all.map((e) => e.id)).toEqual(['e2', 'e1']);
  });

  it('过滤：taskId / employeeId / type / since', async () => {
    const store = new FileEventStore(root);
    await store.append(ev({ id: 'a', taskId: 'TASK-1', employeeId: 'emp-01', type: 'thinking', ts: 1000 }));
    await store.append(ev({ id: 'b', taskId: 'TASK-1', employeeId: 'emp-02', type: 'tool_call', ts: 2000 }));
    await store.append(ev({ id: 'c', taskId: 'TASK-2', employeeId: 'emp-01', type: 'tool_call', ts: 3000 }));

    expect((await store.list({ taskId: 'TASK-1' })).map((e) => e.id)).toEqual(['a', 'b']);
    expect((await store.list({ employeeId: 'emp-01' })).map((e) => e.id)).toEqual(['a', 'c']);
    expect((await store.list({ type: 'tool_call' })).map((e) => e.id)).toEqual(['b', 'c']);
    expect((await store.list({ since: 2000 })).map((e) => e.id)).toEqual(['b', 'c']);
    expect((await store.list({ taskId: 'TASK-1', type: 'thinking' })).map((e) => e.id)).toEqual(['a']);
  });

  it('容错：半行（写入中）跳过不抛错', async () => {
    const dir = join(root, 'ev');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'events.jsonl'), '{"id":"e1","ts":1,"taskId":"T","employeeId":"e","type":"thinking","summary":"s"}\n{"id":"half"', 'utf8');

    const all = await new FileEventStore(root).list();
    expect(all.map((e) => e.id)).toEqual(['e1']);
  });
});
