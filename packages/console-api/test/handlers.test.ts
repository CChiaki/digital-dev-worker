import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHandlers } from '../src/http/handlers.js';
import { FileTaskStore, FileEventStore } from '../src/stores/index.js';
import { FileCapabilityStore, KNOWN_MCP_PACKS } from '../src/team/capabilities.js';
import { FileEmployeeStore } from '../src/team/employee-store.js';
import { FileChannelStore } from '../src/team/notifier.js';
import type { NotificationChannelDef } from '../src/team/notifier.js';
import { FileSkillStore } from '../src/team/skill-store.js';
import type { CapabilityDef } from '../src/team/capabilities.js';
import type { AgentEvent } from '@ddw/runtime';
import { parseTaskPackage } from '@ddw/runtime';
import { IntegrityMonitor } from '../src/team/integrity-monitor.js';

let root: string;
let tasks: FileTaskStore;
let events: FileEventStore;
let handle: ReturnType<typeof createHandlers>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-console-'));
  tasks = new FileTaskStore(root);
  events = new FileEventStore(root);
  handle = createHandlers({ tasks, events });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function sampleYaml(): Promise<string> {
  return readFile(new URL('../../../examples/task-package.example.yaml', import.meta.url), 'utf8');
}

describe('POST /api/tasks（固化任务包）', () => {
  it('yaml 文本入库 → 201（创建默认 draft，2026-09-06 发布态）', async () => {
    const res = await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ taskId: 'TASK-2026-0912-001', status: 'draft' });
    expect((await tasks.list()).length).toBe(1);
  });

  it('非法 yaml → 400 带可读原因', async () => {
    const res = await handle({ method: 'POST', path: '/api/tasks', body: 'title: 缺 taskId' });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toContain('taskId');
  });

  it('taskId 重复：draft/pending 允许覆盖（draft 改稿；pending 未接单撤回重发，2026-09-08 竞态防护细化）', async () => {
    await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    // draft → 覆盖允许（改草稿语义）
    const redraft = await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    expect(redraft.status).toBe(201);
    // 发布为 pending（未接单）后再创建同 taskId → 允许覆盖：无执行档案可断链，
    // 且系统无任务删除入口，覆盖是错发任务唯一的修正通道；覆盖后回 draft 需重新发布
    await handle({ method: 'POST', path: '/api/tasks/TASK-2026-0912-001/publish', body: {} });
    const repend = await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    expect(repend.status).toBe(201);
    expect(await tasks.get('TASK-2026-0912-001')).toMatchObject({ status: 'draft' });
  });

  it('运行中（claimed/running 活跃态）重提交同 taskId → 400 拒绝、记录不被换；新 taskId 正常（2026-09-08 竞态防护）', async () => {
    await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    const id = 'TASK-2026-0912-001';
    await handle({ method: 'POST', path: `/api/tasks/${id}/publish`, body: {} });
    await handle({ method: 'POST', path: `/api/tasks/${id}/claim`, body: { employeeId: 'emp-01' } });
    // claimed（已接单未开跑）即活跃态
    let dup = await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    expect(dup.status).toBe(400);
    expect((dup.json as { error: string }).error).toContain('正在执行中');
    expect((dup.json as { error: string }).error).toContain('断点续跑');
    await tasks.markRunning(id);
    // running 同样拒绝，且执行中记录未被覆盖换掉
    dup = await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    expect(dup.status).toBe(400);
    expect(await tasks.get(id)).toMatchObject({ status: 'running', claimedBy: 'emp-01' });
    // 新 taskId 正常创建，不受既有活跃任务影响
    const other = await handle({
      method: 'POST', path: '/api/tasks', body: (await sampleYaml()).replace(id, 'TASK-OTHER-001'),
    });
    expect(other.status).toBe(201);
  });

  it('终态（failed/done）重提交同 taskId → 201 覆盖，重提直接回 pending 待分派（2026-09-10）', async () => {
    const id = 'TASK-2026-0912-001';
    await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    await handle({ method: 'POST', path: `/api/tasks/${id}/publish`, body: {} });
    await handle({ method: 'POST', path: `/api/tasks/${id}/claim`, body: { employeeId: 'emp-01' } });
    // failed 终态 → 允许覆盖重跑；重提回 pending（不再是 draft 待发布）
    await handle({
      method: 'POST', path: `/api/tasks/${id}/finish`,
      body: { outcome: { status: 'failed', reply: '挂了', turns: 2 }, ok: false },
    });
    const refail = await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    expect(refail.status).toBe(201);
    expect(refail.json).toMatchObject({ status: 'pending' });
    // 再走一轮到 done 终态 → 仍允许覆盖，同样直接回 pending
    await handle({ method: 'POST', path: `/api/tasks/${id}/claim`, body: { employeeId: 'emp-01' } });
    await handle({
      method: 'POST', path: `/api/tasks/${id}/finish`,
      body: { outcome: { status: 'done', reply: '成了', turns: 3 }, ok: true },
    });
    const redone = await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    expect(redone.status).toBe(201);
    expect(redone.json).toMatchObject({ status: 'pending' });
    expect(await tasks.get(id)).toMatchObject({ status: 'pending' });
  });
});

describe('POST /api/tasks/parse（AI 解析，2026-09-06）', () => {
  it('注入 taskParser 透传；未配置 400；缺 description 400', async () => {
    const h = createHandlers({ tasks, events, taskParser: async (d) => ({ yaml: `# ${d}` }) });
    const r = await h({ method: 'POST', path: '/api/tasks/parse', body: { description: '登录功能' } });
    expect(r.status).toBe(200);
    expect((r.json as { yaml: string }).yaml).toBe('# 登录功能');
    expect((await h({ method: 'POST', path: '/api/tasks/parse', body: {} })).status).toBe(400);
    const h2 = createHandlers({ tasks, events });
    expect((await h2({ method: 'POST', path: '/api/tasks/parse', body: { description: 'x' } })).status).toBe(400);
  });
});

describe('GET /api/tasks 与 /api/tasks/:taskId', () => {
  it('列表含状态；详情返回完整记录；不存在 404', async () => {
    await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    await handle({ method: 'POST', path: '/api/tasks/TASK-2026-0912-001/publish', body: {} });
    const list = await handle({ method: 'GET', path: '/api/tasks' });
    expect(list.status).toBe(200);
    expect((list.json as { taskId: string; status: string }[])[0]).toMatchObject({
      taskId: 'TASK-2026-0912-001',
      status: 'pending',
    });

    const detail = await handle({ method: 'GET', path: '/api/tasks/TASK-2026-0912-001' });
    expect(detail.status).toBe(200);
    expect((detail.json as { pkg: { title: string } }).pkg.title).toBe('登录模块前端重构');

    expect((await handle({ method: 'GET', path: '/api/tasks/NOPE' })).status).toBe(404);
  });

  it('任务包含 assignee：摘要透传 assignee；无 assignee 不出键（2026-09-06 指定员工）', async () => {
    await handle({
      method: 'POST', path: '/api/tasks',
      body: 'taskId: T-A\ntitle: 有点名\nrepo: { url: "http://x/a.git", branch: main }\nassignee: emp-01\nplan:\n  - { id: t1, title: p, detail: d }\n',
    });
    await handle({
      method: 'POST', path: '/api/tasks',
      body: 'taskId: T-B\ntitle: 无点名\nrepo: { url: "http://x/b.git", branch: main }\nplan:\n  - { id: t1, title: p, detail: d }\n',
    });
    const list = (await handle({ method: 'GET', path: '/api/tasks' })).json as Record<string, unknown>[];
    const withA = list.find((t) => t.taskId === 'T-A')!;
    const noA = list.find((t) => t.taskId === 'T-B')!;
    expect(withA.assignee).toBe('emp-01');
    // 缺省 undefined：JSON 序列化后不出 assignee 键（HTTP 响应同效）
    expect(noA.assignee).toBeUndefined();
  });
});

describe('POST /api/tasks/:id/publish（2026-09-06 发布态）', () => {
  it('POST /api/tasks 创建默认 draft；publish 发布为 pending；重复发布 409', async () => {
    const created = await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    expect(created.status).toBe(201);
    expect((created.json as { status: string }).status).toBe('draft');
    const taskId = (created.json as { taskId: string }).taskId;

    const pub = await handle({ method: 'POST', path: `/api/tasks/${taskId}/publish`, body: {} });
    expect(pub.status).toBe(200);
    expect((pub.json as { status: string }).status).toBe('pending');

    // 已发布（pending）再发布 → 409
    expect((await handle({ method: 'POST', path: `/api/tasks/${taskId}/publish`, body: {} })).status).toBe(409);

    // 不存在的任务 → 404
    expect((await handle({ method: 'POST', path: '/api/tasks/NOPE/publish', body: {} })).status).toBe(404);
  });

  it('发布前仓库可达性校验（2026-09-06 实战修复）：不可达 400 拦截不进调度；可达照常发布', async () => {
    const rejected = createHandlers({ tasks, events, repoCheck: async (url) => { throw new Error(`仓库不可达（${url}）`); } });
    const created = await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    const taskId = (created.json as { taskId: string }).taskId;

    // 不可达 → 400 带 url 文案，任务仍是 draft（未进调度）
    const blocked = await rejected({ method: 'POST', path: `/api/tasks/${taskId}/publish`, body: {} });
    expect(blocked.status).toBe(400);
    expect((blocked.json as { error: string }).error).toContain('仓库不可达');
    expect(((await tasks.get(taskId))!.status)).toBe('draft');

    // 可达 → 照常发布
    const passing = createHandlers({ tasks, events, repoCheck: async () => {} });
    const pub = await passing({ method: 'POST', path: `/api/tasks/${taskId}/publish`, body: {} });
    expect(pub.status).toBe(200);
    expect((pub.json as { status: string }).status).toBe('pending');
  });
});

describe('POST /api/tasks/:taskId/claim', () => {
  it('接单 → 200 claimed；重复接单 409；缺 employeeId 400', async () => {
    await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    const id = 'TASK-2026-0912-001';
    await handle({ method: 'POST', path: `/api/tasks/${id}/publish`, body: {} });

    const ok = await handle({ method: 'POST', path: `/api/tasks/${id}/claim`, body: { employeeId: 'emp-01' } });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ status: 'claimed', claimedBy: 'emp-01' });

    const dup = await handle({ method: 'POST', path: `/api/tasks/${id}/claim`, body: { employeeId: 'emp-02' } });
    expect(dup.status).toBe(409);

    const bad = await handle({ method: 'POST', path: `/api/tasks/${id}/claim`, body: {} });
    expect(bad.status).toBe(400);
  });

  it('不存在的任务接单 → 404', async () => {
    const res = await handle({ method: 'POST', path: '/api/tasks/NOPE/claim', body: { employeeId: 'emp-01' } });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/tasks/:taskId/finish', () => {
  it('回写结果 → 200 done/failed', async () => {
    await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    const id = 'TASK-2026-0912-001';
    await handle({ method: 'POST', path: `/api/tasks/${id}/publish`, body: {} });
    await handle({ method: 'POST', path: `/api/tasks/${id}/claim`, body: { employeeId: 'emp-01' } });

    const res = await handle({
      method: 'POST',
      path: `/api/tasks/${id}/finish`,
      body: { outcome: { status: 'done', reply: 'MR !42 已创建', turns: 5 }, ok: true },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'done' });
  });
});

describe('POST /api/tasks/:taskId/assign（2026-09-06 分派分离）', () => {
  /** 员工档案：emp-01 启用、emp-off 停用 */
  async function seedEmployees(): Promise<FileEmployeeStore> {
    const store = new FileEmployeeStore(join(root, 'employees.json'));
    await store.upsert({ id: 'emp-01', name: '张后端', roles: ['backend'], skills: [], capabilities: [], enabled: true, createdAt: Date.now() });
    await store.upsert({ id: 'emp-off', name: '已停用', roles: ['backend'], skills: [], capabilities: [], enabled: false, createdAt: Date.now() });
    return store;
  }

  it('指定启用员工 → 200 返回 TaskRecord（pkg.assignee 落库）；取消指定后 pkg 无 assignee 键', async () => {
    const h = createHandlers({ tasks, events, employeeStore: await seedEmployees() });
    await h({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    const id = 'TASK-2026-0912-001';

    const assigned = await h({ method: 'POST', path: `/api/tasks/${id}/assign`, body: { employeeId: 'emp-01' } });
    expect(assigned.status).toBe(200);
    expect((assigned.json as { pkg: { assignee?: string } }).pkg.assignee).toBe('emp-01');
    expect((await tasks.get(id))!.pkg.assignee).toBe('emp-01');

    // 改派（draft → 仍 draft 状态可改）与取消指定（employeeId 缺省 = null）
    const cancelled = await h({ method: 'POST', path: `/api/tasks/${id}/assign`, body: {} });
    expect(cancelled.status).toBe(200);
    expect((cancelled.json as { pkg: { assignee?: string } }).pkg.assignee).toBeUndefined();
    expect('assignee' in (await tasks.get(id))!.pkg).toBe(false);
  });

  it('员工不存在或已停用 → 400 可读文案；employeeId 空白串视同取消指定', async () => {
    const h = createHandlers({ tasks, events, employeeStore: await seedEmployees() });
    await h({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    const id = 'TASK-2026-0912-001';

    const unknown = await h({ method: 'POST', path: `/api/tasks/${id}/assign`, body: { employeeId: 'emp-x' } });
    expect(unknown.status).toBe(400);
    expect((unknown.json as { error: string }).error).toBe('指定员工不可用（emp-x）：不存在或已停用');

    const disabled = await h({ method: 'POST', path: `/api/tasks/${id}/assign`, body: { employeeId: 'emp-off' } });
    expect(disabled.status).toBe(400);
    expect((disabled.json as { error: string }).error).toContain('不存在或已停用');

    // 空白串 → 取消指定（200，非 400）
    const cancel = await h({ method: 'POST', path: `/api/tasks/${id}/assign`, body: { employeeId: '  ' } });
    expect(cancel.status).toBe(200);
  });

  it('未注入 employeeStore → 400；状态不对（claimed）→ 409 原样 message；任务不存在 → 404', async () => {
    // 未注入员工档案
    await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    const id = 'TASK-2026-0912-001';
    const noStore = await handle({ method: 'POST', path: `/api/tasks/${id}/assign`, body: { employeeId: 'emp-01' } });
    expect(noStore.status).toBe(400);
    expect((noStore.json as { error: string }).error).toBe('未启用员工档案（需一体化模式）');

    // claimed 任务不可指定
    const h = createHandlers({ tasks, events, employeeStore: await seedEmployees() });
    await h({ method: 'POST', path: `/api/tasks/${id}/publish`, body: {} });
    await h({ method: 'POST', path: `/api/tasks/${id}/claim`, body: { employeeId: 'emp-01' } });
    const conflict = await h({ method: 'POST', path: `/api/tasks/${id}/assign`, body: { employeeId: 'emp-01' } });
    expect(conflict.status).toBe(409);
    expect((conflict.json as { error: string }).error).toContain('仅待发布/待分派任务可指定员工');

    // 不存在的任务 → 404
    expect((await h({ method: 'POST', path: '/api/tasks/NOPE/assign', body: { employeeId: 'emp-01' } })).status).toBe(404);
  });
});

describe('GET /api/events（直播数据源）', () => {
  it('按 taskId/type/since 过滤', async () => {
    const ev = (id: string, over: Partial<AgentEvent>): AgentEvent => ({
      id, ts: 1000, taskId: 'T1', employeeId: 'emp-01', type: 'thinking', summary: id, ...over,
    });
    await events.append(ev('a', { ts: 1000, type: 'thinking' }));
    await events.append(ev('b', { ts: 2000, type: 'tool_call', summary: 'gitlab_create_branch' }));

    const all = await handle({ method: 'GET', path: '/api/events', query: { taskId: 'T1' } });
    expect((all.json as AgentEvent[]).length).toBe(2);

    const tools = await handle({ method: 'GET', path: '/api/events', query: { taskId: 'T1', type: 'tool_call' } });
    expect((tools.json as AgentEvent[]).map((e) => e.id)).toEqual(['b']);

    const since = await handle({ method: 'GET', path: '/api/events', query: { taskId: 'T1', since: '2000' } });
    expect((since.json as AgentEvent[]).map((e) => e.id)).toEqual(['b']);
  });
});

describe('GET /api/audit（审计台账 v1）', () => {
  it('全事件倒序 + 按 type 计数汇总', async () => {
    const ev = (id: string, type: AgentEvent['type'], ts: number): AgentEvent => ({
      id, ts, taskId: 'T1', employeeId: 'emp-01', type, summary: id,
    });
    await events.append(ev('e1', 'thinking', 1000));
    await events.append(ev('e2', 'tool_call', 2000));
    await events.append(ev('e3', 'thinking', 3000));
    await events.append(ev('e4', 'intervention', 4000));

    const res = await handle({ method: 'GET', path: '/api/audit' });
    expect(res.status).toBe(200);
    const audit = res.json as { total: number; byType: Record<string, number>; events: AgentEvent[] };
    expect(audit.total).toBe(4);
    expect(audit.byType).toEqual({ thinking: 2, tool_call: 1, intervention: 1 });
    expect(audit.events.map((e) => e.id)).toEqual(['e4', 'e3', 'e2', 'e1']);
  });
});

describe('GET /api/employees（数字员工名册，P9-T3）', () => {
  const emp = (id: string, role: string, skills: string[]): import('@ddw/runtime').EmployeeProfile => ({
    id, name: `员工${id}`, role, skills,
  });

  it('忙闲由任务池 claimed/running 推导；无claimed任务时全空闲', async () => {
    const h = createHandlers({
      tasks, events,
      employees: [emp('emp-01', 'backend', ['backend', 'test']), emp('emp-02', 'frontend', ['frontend'])],
    });
    const yaml = await sampleYaml();
    await h({ method: 'POST', path: '/api/tasks', body: yaml });
    await h({ method: 'POST', path: '/api/tasks/TASK-2026-0912-001/publish', body: {} });
    await h({ method: 'POST', path: '/api/tasks/TASK-2026-0912-001/claim', body: { employeeId: 'emp-01' } });

    const res = await h({ method: 'GET', path: '/api/employees' });
    expect(res.status).toBe(200);
    const roster = res.json as { id: string; busy: boolean; runningTasks: string[]; supervision: string }[];
    expect(roster).toHaveLength(2);
    expect(roster[0]).toMatchObject({ id: 'emp-01', busy: true, runningTasks: ['TASK-2026-0912-001'], supervision: 'shadow' });
    expect(roster[1]).toMatchObject({ id: 'emp-02', busy: false, runningTasks: [] });
  });

  it('yaml 回退视图不再下发退役 skills 字段（2026-09-08 口径与 store 分支对齐）', async () => {
    const h = createHandlers({
      tasks, events,
      employees: [emp('emp-01', 'backend', ['backend', 'test'])],
    });
    const res = await h({ method: 'GET', path: '/api/employees' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).not.toContain('"skills"');
  });

  it('未提供名册（纯控制台模式）返回空数组', async () => {
    const res = await handle({ method: 'GET', path: '/api/employees' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
  });
});

describe('GET /api/checks 与 POST review（人工盯梢闭环，P10-T3）', () => {
  const ev = (over: Partial<AgentEvent> & { id: string }): AgentEvent => ({
    ts: 1, taskId: 'TASK-1', employeeId: 'emp-01', type: 'task_check', summary: over.id, ...over,
  });

  it('待审列表从事件流推导；review 放行后事件追加', async () => {
    // 2026-09-10 存活过滤：待审须属执行中任务（终态/不存在 = 幽灵，放行必 404 不展示）
    await tasks.add(parseTaskPackage('taskId: TASK-1\ntitle: t\nrepo: { url: "http://gitlab.inner.bank/x.git", branch: main }\ntasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]'));
    await tasks.claim('TASK-1', 'emp-01');
    await events.append(ev({ id: 'c1', payload: { item: 'T-1', result: '构建通过', awaiting: true } }));
    const list = (await handle({ method: 'GET', path: '/api/checks' })).json as { taskId: string; item: string }[];
    expect(list).toEqual([{ taskId: 'TASK-1', item: 'T-1', result: '构建通过' }]);
  });

  it('POST review 唤醒闸门：放行返回 approved=true，未知节点 404', async () => {
    const { CheckReviewQueue, gateForTask } = await import('../src/team/review-gate.js');
    const queue = new CheckReviewQueue();
    const h = createHandlers({ tasks, events, reviewQueue: queue });
    const gate = gateForTask(queue, 'TASK-1');
    const pending = gate.review({ item: 'T-1', result: 'x', passed: true });

    const res = await h({ method: 'POST', path: '/api/tasks/TASK-1/checks/T-1/review', body: { approved: true, comment: 'OK' } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ taskId: 'TASK-1', item: 'T-1', approved: true, comment: 'OK' });
    expect(await pending).toMatchObject({ approved: true });

    const miss = await h({ method: 'POST', path: '/api/tasks/TASK-1/checks/T-9/review', body: { approved: false } });
    expect(miss.status).toBe(404);
    expect((miss.json as { error: string }).error).toContain('待审节点不存在');
  });

  it('未启用复核（纯控制台）review → 400；缺 approved → 400', async () => {
    const res = await handle({ method: 'POST', path: '/api/tasks/TASK-1/checks/T-1/review', body: { approved: true } });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toContain('未启用人工复核');

    const { CheckReviewQueue } = await import('../src/team/review-gate.js');
    const h = createHandlers({ tasks, events, reviewQueue: new CheckReviewQueue() });
    const bad = await h({ method: 'POST', path: '/api/tasks/TASK-1/checks/T-1/review', body: {} });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: string }).error).toContain('approved');
  });

  it('待审列表按任务存活过滤（2026-09-10 角标数值不对）：终态任务的幽灵待审不再出现', async () => {
    // TASK-GHOST：done 终态残留待审（执行结束 resolver 已消亡，放行必 404）
    await events.append(ev({ id: 'g1', taskId: 'TASK-GHOST', payload: { item: 'T-1', result: '构建通过', awaiting: true } }));
    await tasks.add(parseTaskPackage('taskId: TASK-GHOST\ntitle: t\nrepo: { url: "http://gitlab.inner.bank/x.git", branch: main }\ntasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]'));
    await tasks.claim('TASK-GHOST', 'emp-01');
    await tasks.finish('TASK-GHOST', { status: 'done', reply: 'done', turns: 1 }, true);
    // TASK-LIVE：执行中，待审正常出现
    await events.append(ev({ id: 'l1', taskId: 'TASK-LIVE', payload: { item: 'T-2', result: '构建通过', awaiting: true } }));
    await tasks.add(parseTaskPackage('taskId: TASK-LIVE\ntitle: t\nrepo: { url: "http://gitlab.inner.bank/x.git", branch: main }\ntasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]'));
    await tasks.claim('TASK-LIVE', 'emp-01');
    await tasks.markRunning('TASK-LIVE');

    const list = (await handle({ method: 'GET', path: '/api/checks' })).json as { taskId: string; item: string }[];
    expect(list).toEqual([{ taskId: 'TASK-LIVE', item: 'T-2', result: '构建通过' }]);
  });

  it('GET /api/checks/history：全量记录（已裁决补 approved/comment + 已失效标记），checkTs 倒序', async () => {
    const t0 = Date.now();
    await events.append(ev({ id: 'h1', ts: t0, taskId: 'TASK-1', payload: { item: 'T-1', result: '构建通过', awaiting: true } }));
    await events.append(ev({ id: 'h2', ts: t0 + 1, taskId: 'TASK-1', type: 'intervention', payload: { item: 'T-1', approved: true, comment: 'OK' } }));
    await events.append(ev({ id: 'h3', ts: t0 + 2, taskId: 'TASK-1', payload: { item: 'bash-1', result: 'rm x', bash: true, awaiting: true } }));
    await events.append(ev({ id: 'h4', ts: t0 + 3, taskId: 'TASK-2', payload: { item: 'T-9', result: '幽灵待审', awaiting: true } }));
    // TASK-2 不存在（或终态）→ 幽灵待审标记 expired
    const recs = (await handle({ method: 'GET', path: '/api/checks/history' })).json as
      Array<{ item: string; pending: boolean; approved?: boolean; comment?: string; bash?: boolean; expired?: boolean; checkTs: number }>;
    expect(recs).toHaveLength(3);
    // checkTs 倒序：最新申报在前
    expect(recs.map((r) => r.item)).toEqual(['T-9', 'bash-1', 'T-1']);
    expect(recs[2]).toMatchObject({ item: 'T-1', pending: false, approved: true, comment: 'OK', checkTs: t0 });
    expect(recs[1]).toMatchObject({ item: 'bash-1', pending: true, bash: true });
    expect(recs[0]).toMatchObject({ item: 'T-9', pending: true, expired: true });
  });
});

describe('操作者留痕 + 渠道凭据密文化（2026-09-11 API token 鉴权）', () => {
  const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

  it('review 带 operator：响应与 verdict 都带操作者名（intervention 落痕链路起点）', async () => {
    const { CheckReviewQueue, gateForTask } = await import('../src/team/review-gate.js');
    const queue = new CheckReviewQueue();
    const h = createHandlers({ tasks, events, reviewQueue: queue });
    const gate = gateForTask(queue, 'TASK-1');
    const pending = gate.review({ item: 'T-1', result: 'x', passed: true });

    const res = await h({ method: 'POST', path: '/api/tasks/TASK-1/checks/T-1/review', body: { approved: true }, operator: '张三' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ approved: true, operator: '张三' });
    expect(await pending).toMatchObject({ approved: true, operator: '张三' });
  });

  it('后台写操作落 config_change 审计事件（taskId/employeeId=console，payload 带 operator）', async () => {
    const channels = new FileChannelStore(join(root, 'channels.json'));
    const h = createHandlers({ tasks, events, channels });
    await h({
      method: 'POST', path: '/api/notification-channels', operator: '李四',
      body: { id: 'c1', type: 'webhook', name: '钩子', webhookUrl: 'http://x.local/hook', enabled: true },
    });
    const cfgEvents = (await events.list()).filter((e) => e.type === 'config_change');
    expect(cfgEvents).toHaveLength(1);
    expect(cfgEvents[0]).toMatchObject({
      taskId: 'console', employeeId: 'console',
      summary: expect.stringContaining('李四'),
      payload: { action: '新建通知渠道', target: 'c1（钩子）', operator: '李四' },
    });
  });

  it('渠道 token 入库加密（DDW_CRED_KEY 在场时 enc:v1: 落库），GET 脱敏不受影响', async () => {
    vi.stubEnv('DDW_CRED_KEY', KEY);
    try {
      const channels = new FileChannelStore(join(root, 'channels.json'));
      const h = createHandlers({ tasks, events, channels });
      const res = await h({
        method: 'POST', path: '/api/notification-channels',
        body: { id: 'yx1', type: 'yanxun', name: '燕讯', webhookUrl: '', token: 'tok-plain', enabled: true },
      });
      expect(res.status).toBe(201);
      const stored = (await channels.list())[0]!;
      expect(stored.token).toMatch(/^enc:v1:/);
      expect(stored.token).not.toContain('tok-plain');
      // GET 仍脱敏（密文不回显，前端零感知）
      const got = (await (await h({ method: 'GET', path: '/api/notification-channels' })).json as NotificationChannelDef[])[0];
      expect(got.token).toBe('***');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('POST /api/tasks/:id/resume（计划续跑，2026-09-05）', () => {
  const YAML = `
taskId: TASK-RESUME-1
title: 计划续跑任务
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
tasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]
`;
  const progress = [
    { itemId: 't1', kind: 'dev', title: '开发', status: 'done' as const },
    { itemId: 't2', kind: 'test', title: '测试', status: 'failed' as const },
    { itemId: 't3', kind: 'commit', title: '提交', status: 'skipped' as const },
  ];

  async function seedFailed(): Promise<string> {
    const pkg = parseTaskPackage(YAML);
    await tasks.add(pkg);
    const taskId = pkg.taskId;
    await tasks.claim(taskId, 'emp-01');
    await tasks.markRunning(taskId);
    await tasks.finish(taskId, { status: 'done', reply: '测试未过', turns: 3 }, false, progress, 't2');
    return taskId;
  }

  it('POST /api/tasks/:id/resume：failed → pending（409 其他状态）；前端可再次触发调度', async () => {
    const taskId = await seedFailed();

    const res = await handle({ method: 'POST', path: `/api/tasks/${taskId}/resume`, body: {} });
    expect(res.status).toBe(200);
    expect((res.json as { status: string }).status).toBe('pending');
    // 续跑保留 progress（done 项不重做）、清停点；失败项复位 skipped 不残留「失败」（2026-09-06）
    expect((res.json as { planProgress: unknown }).planProgress).toEqual([
      { itemId: 't1', kind: 'dev', title: '开发', status: 'done' },
      { itemId: 't2', kind: 'test', title: '测试', status: 'skipped' },
      { itemId: 't3', kind: 'commit', title: '提交', status: 'skipped' },
    ]);
    expect((res.json as { failedItemId?: string }).failedItemId).toBeUndefined();
    // 谁失败谁继续：原执行员工（seed claim emp-01）写为 assignee 点名续接（2026-09-06 用户语义）
    expect(((res.json as { pkg: { assignee?: string } }).pkg).assignee).toBe('emp-01');

    // 已续跑（pending）再续 → 409
    expect((await handle({ method: 'POST', path: `/api/tasks/${taskId}/resume`, body: {} })).status).toBe(409);

    // 不存在的任务 → 404
    expect((await handle({ method: 'POST', path: '/api/tasks/NOPE/resume', body: {} })).status).toBe(404);
  });

  it('GET /api/tasks 摘要带 planProgress/failedItemId', async () => {
    const taskId = await seedFailed();
    const list = await handle({ method: 'GET', path: '/api/tasks' });
    expect((list.json as { taskId: string; planProgress: unknown; failedItemId: string }[])[0]).toMatchObject({
      taskId,
      failedItemId: 't2',
    });
  });
});

describe('POST /api/tasks/:id/force-reset（强制重置，2026-09-11 P0 韧性批）', () => {
  const YAML = `
taskId: TASK-FORCE-1
title: 强制重置任务
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
tasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]
`;

  it('running → pending 清执行态；在途任务先调 onForceReset 中性化（迟到回写守卫）；留痕带 operator', async () => {
    const pkg = parseTaskPackage(YAML);
    await tasks.add(pkg);
    const taskId = pkg.taskId;
    await tasks.claim(taskId, 'emp-01');
    await tasks.markRunning(taskId);

    const resets: Array<[string, string | undefined]> = [];
    const h = createHandlers({ tasks, events, onForceReset: (id, by) => resets.push([id, by]) });

    const res = await h({ method: 'POST', path: `/api/tasks/${taskId}/force-reset`, body: {}, operator: '张三' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'pending' });
    // 执行态全清（claimedBy/result/progress/停点）
    expect(res.json).not.toHaveProperty('claimedBy');
    expect(res.json).not.toHaveProperty('result');
    // 在途执行先中性化：onForceReset 拿到 (taskId, claimedBy)——server 接线到 scheduler.abandon
    expect(resets).toEqual([[taskId, 'emp-01']]);
    // 重置动作留痕 dispatch 事件（含操作者名，审计链可追谁重置的）
    const trail = (await events.list()).filter((e) => e.type === 'dispatch' && e.summary.includes('强制重置'));
    expect(trail).toHaveLength(1);
    expect(trail[0]!.summary).toContain('张三');
    expect(trail[0]!.taskId).toBe(taskId);
  });

  it('draft → 409 可读错误；不存在 → 404；done 终态也可重置（回 pending 重跑）', async () => {
    const pkg = parseTaskPackage(YAML);
    await tasks.add(pkg, { draft: true });
    const draft = await handle({ method: 'POST', path: `/api/tasks/${pkg.taskId}/force-reset`, body: {} });
    expect(draft.status).toBe(409);
    expect((draft.json as { error: string }).error).toContain('draft');

    expect((await handle({ method: 'POST', path: '/api/tasks/NOPE/force-reset', body: {} })).status).toBe(404);

    // done → pending：终态任务重置后可重新执行（比重提交 yaml 更直接）
    await tasks.publish(pkg.taskId);
    await tasks.claim(pkg.taskId, 'emp-01');
    await tasks.finish(pkg.taskId, { status: 'done', reply: '完成', turns: 1 }, true);
    const done = await handle({ method: 'POST', path: `/api/tasks/${pkg.taskId}/force-reset`, body: {} });
    expect(done.status).toBe(200);
    expect((done.json as { status: string }).status).toBe('pending');
  });
});

describe('员工 CRUD API（2026-09-06 后台化）', () => {
  let caps: FileCapabilityStore;

  beforeEach(async () => {
    caps = new FileCapabilityStore(join(root, 'capabilities.json'));
    await caps.ensureSeed();
  });

  it('员工 CRUD：GET（含 busy/runningTasks/capabilities/enabled）+ POST + PUT + DELETE(停用)', async () => {
    const store = new FileEmployeeStore(join(root, 'employees.json'));
    const handle = createHandlers({ tasks, events, employees: [], employeeStore: store, capabilities: caps });
    expect((await handle({ method: 'GET', path: '/api/employees' })).json).toEqual([]); // 空 store
    const created = await handle({ method: 'POST', path: '/api/employees',
      body: { id: 'emp-09', name: '王五', role: '测试', skills: ['test'], capabilities: ['test'], enabled: true } });
    expect(created.status).toBe(201);
    const list = (await handle({ method: 'GET', path: '/api/employees' })).json as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({ id: 'emp-09', capabilities: ['test'], enabled: true, busy: false });
    const updated = await handle({ method: 'PUT', path: '/api/employees/emp-09',
      body: { id: 'emp-09', name: '王五2', role: '测试', skills: ['test'], capabilities: ['test', 'dev'], enabled: true } });
    expect(updated.status).toBe(200);
    const disabled = await handle({ method: 'DELETE', path: '/api/employees/emp-09', body: {} });
    expect(disabled.status).toBe(200);
    expect(((await handle({ method: 'GET', path: '/api/employees' })).json as Array<Record<string, unknown>>)[0]!.enabled).toBe(false);
    // id 冲突 409
    expect((await handle({ method: 'POST', path: '/api/employees',
      body: { id: 'emp-09', name: 'x', role: 'y', skills: [], capabilities: [], enabled: true } })).status).toBe(409);
    // 未注册能力 400
    expect((await handle({ method: 'POST', path: '/api/employees',
      body: { id: 'emp-10', name: 'x', role: 'y', skills: [], capabilities: ['nope'], enabled: true } })).status).toBe(400);
  });

  it('员工模型绑定（一人一模型一 key，2026-09-06 增补）：GET 脱敏、PUT 留空保 key、校验 400', async () => {
    const store = new FileEmployeeStore(join(root, 'employees.json'));
    const handle = createHandlers({ tasks, events, employeeStore: store, capabilities: caps });
    await handle({ method: 'POST', path: '/api/employees',
      body: { id: 'emp-m', name: '模型工', role: '后端', skills: ['backend'], capabilities: [],
        model: { baseUrl: 'http://m.local/v1', apiKey: 'sk-real', model: 'glm-x', api: 'anthropic-messages' }, enabled: true } });
    // GET 脱敏：apiKey 返回 '***'
    const list = (await handle({ method: 'GET', path: '/api/employees' })).json as Array<{ id: string; model?: { apiKey: string } }>;
    expect(list.find((e) => e.id === 'emp-m')!.model!.apiKey).toBe('***');
    // PUT 留空保 key
    const put = await handle({ method: 'PUT', path: '/api/employees/emp-m',
      body: { id: 'emp-m', name: '模型工', role: '后端', skills: ['backend'], capabilities: [],
        model: { baseUrl: 'http://m.local/v1', apiKey: '', model: 'glm-x' }, enabled: true } });
    expect(put.status).toBe(200);
    const raw = await store.get('emp-m');
    expect(raw!.model!.apiKey).toBe('sk-real');           // 库里仍是原 key
    expect(raw!.model!.api).toBe('anthropic-messages');   // 其余字段正常更新
    // PUT '***' 同样保 key；新绑定 apiKey 留空 400
    expect((await handle({ method: 'PUT', path: '/api/employees/emp-m',
      body: { id: 'emp-m', name: 'x', role: 'r', skills: ['backend'], capabilities: [],
        model: { baseUrl: 'u', apiKey: '***', model: 'm' }, enabled: true } })).status).toBe(200);
    expect((await handle({ method: 'POST', path: '/api/employees',
      body: { id: 'emp-n', name: 'x', role: 'r', skills: [], capabilities: [],
        model: { baseUrl: 'u', apiKey: '', model: 'm' }, enabled: true } })).status).toBe(400);
  });

  it('员工 model.apiKey 密文落库（2026-09-11 复盘批）：POST 明文 → 库里 enc:v1:；PUT 回写幂等；GET 仍 ***', async () => {
    const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
    vi.stubEnv('DDW_CRED_KEY', KEY);
    try {
      const store = new FileEmployeeStore(join(root, 'employees.json'));
      const handle = createHandlers({ tasks, events, employeeStore: store, capabilities: caps });
      await handle({ method: 'POST', path: '/api/employees',
        body: { id: 'emp-enc', name: '密文工', role: '后端', skills: ['backend'], capabilities: [],
          model: { baseUrl: 'http://m.local/v1', apiKey: 'sk-plain', model: 'glm-x' }, enabled: true } });
      const raw = await store.get('emp-enc');
      expect(raw!.model!.apiKey).toMatch(/^enc:v1:/);      // 库里是密文，不是明文
      expect(raw!.model!.apiKey).not.toContain('sk-plain');
      // PUT 带 '***'：保留库里密文（幂等跳过，不二次加密）
      await handle({ method: 'PUT', path: '/api/employees/emp-enc',
        body: { id: 'emp-enc', name: '密文工', role: '后端', skills: ['backend'], capabilities: [],
          model: { baseUrl: 'http://m.local/v1', apiKey: '***', model: 'glm-x' }, enabled: true } });
      expect((await store.get('emp-enc'))!.model!.apiKey).toBe(raw!.model!.apiKey);
      // GET 照旧脱敏
      const list = (await handle({ method: 'GET', path: '/api/employees' })).json as Array<{ id: string; model?: { apiKey: string } }>;
      expect(list.find((e) => e.id === 'emp-enc')!.model!.apiKey).toBe('***');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('未注入 employeeStore 时 POST/PUT/DELETE 员工返回 400（GET 回退 profiles 零回归）', async () => {
    const handle = createHandlers({ tasks, events, employees: [{ id: 'e', name: 'n', role: 'r', skills: [] }] });
    expect((await handle({ method: 'POST', path: '/api/employees', body: {} })).status).toBe(400);
    const list = (await handle({ method: 'GET', path: '/api/employees' })).json as Array<Record<string, unknown>>;
    expect(list[0]!.id).toBe('e');
  });

  it('supervision 扁平字符串归一化（终审修复）：前端 payload 形状 POST/PUT 全链路 200；非法字符串 400', async () => {
    const store = new FileEmployeeStore(join(root, 'employees.json'));
    const handle = createHandlers({ tasks, events, employeeStore: store, capabilities: caps });
    // 前端实际 payload 形状：supervision 为扁平字符串（EmployeeEditDialog 提交 / Employees.vue 启用开关 PUT 整行）
    const created = await handle({ method: 'POST', path: '/api/employees',
      body: { id: 'emp-s', name: '小监', role: '后端', skills: ['backend'], capabilities: [], supervision: 'assisted', enabled: true } });
    expect(created.status).toBe(201);
    // GET 往返仍是扁平字符串，再 PUT 整行（启用开关同形状）不 400
    const row = ((await handle({ method: 'GET', path: '/api/employees' })).json as Array<{ id: string; supervision: string }>)
      .find((e) => e.id === 'emp-s')!;
    expect(row.supervision).toBe('assisted');
    const put = await handle({ method: 'PUT', path: '/api/employees/emp-s',
      body: { id: 'emp-s', name: '小监2', role: '后端', skills: ['backend'], capabilities: [], supervision: 'trusted', enabled: true } });
    expect(put.status).toBe(200);
    // 落盘为对象形状（与 runtime EmployeeProfile 同构，managed-roster 原样注入）
    expect((await store.get('emp-s'))!.supervision).toEqual({ level: 'trusted' });
    // 非法字符串仍 400（对象形状非法取值同语义）
    expect((await handle({ method: 'PUT', path: '/api/employees/emp-s',
      body: { id: 'emp-s', name: 'x', role: 'r', skills: ['backend'], capabilities: [], supervision: 'nope', enabled: true } })).status).toBe(400);
    expect((await handle({ method: 'POST', path: '/api/employees',
      body: { id: 'emp-s2', name: 'x', role: 'r', skills: [], capabilities: [], supervision: { level: 'nope' }, enabled: true } })).status).toBe(400);
  });

  it('PUT 员工保留 createdAt（终审修复）：首次编辑后创建时间不丢', async () => {
    const store = new FileEmployeeStore(join(root, 'employees.json'));
    const handle = createHandlers({ tasks, events, employeeStore: store, capabilities: caps });
    await handle({ method: 'POST', path: '/api/employees',
      body: { id: 'emp-t', name: '时工', role: '后端', skills: ['backend'], capabilities: [], enabled: true } });
    const before = (await store.get('emp-t'))!.createdAt;
    expect(before).toBeGreaterThan(0);
    const put = await handle({ method: 'PUT', path: '/api/employees/emp-t',
      body: { id: 'emp-t', name: '时工2', role: '后端', skills: ['backend'], capabilities: [], enabled: true } });
    expect(put.status).toBe(200);
    expect((await store.get('emp-t'))!.createdAt).toBe(before);
  });

  it('POST employees role 非注册岗位 → 400 且文案含岗位清单（2026-09-07 岗位即分类）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skills-role-'));
    const skills = new FileSkillStore(join(dir, 'skills.json'));
    await skills.ensureSeed(); // 对齐生产接线（server.ts 首启 seed）：岗位白名单 = 分类 name 清单
    const store = new FileEmployeeStore(join(root, 'employees.json'));
    const handle = createHandlers({ tasks, events, employeeStore: store, skills });
    const res = await handle({ method: 'POST', path: '/api/employees', body: {
      id: 'e9', name: '小九', role: '不存在的岗位', capabilities: [], enabled: true,
    } });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toMatch(/必须是已注册岗位/);
    expect((res.json as { error: string }).error).toMatch(/后端开发/); // seed 分类 name 在岗位清单中
  });

  it('employees POST 退役 skillCategories 忽略不校验（任意取值 201）；GET 视图不再下发该字段', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skills-emp-'));
    const skills = new FileSkillStore(join(dir, 'skills.json'));
    await skills.ensureSeed();
    const store = new FileEmployeeStore(join(root, 'employees.json'));
    const handle = createHandlers({ tasks, events, employeeStore: store, skills });
    const res = await handle({ method: 'POST', path: '/api/employees', body: {
      id: 'emp-sk', name: '小技', role: '后端开发', skills: ['backend'], capabilities: [],
      skillCategories: ['backend'], supervision: 'shadow', enabled: true,
    } });
    expect(res.status).toBe(201);
    // 退役语义：skillCategories 不再参与白名单校验，未注册分类也不再 400
    const bad = await handle({ method: 'POST', path: '/api/employees', body: {
      id: 'emp-bad', name: '错', role: '后端开发', skills: ['backend'], capabilities: [],
      skillCategories: ['nope'], supervision: 'shadow', enabled: true,
    } });
    expect(bad.status).toBe(201);
    const list = await handle({ method: 'GET', path: '/api/employees' });
    // 2026-09-08 收尾：员工视图彻底下线 skillCategories（存储兼容保留，仅不再下发）
    const empSk = (list.json as Record<string, unknown>[]).find((e) => e.id === 'emp-sk');
    expect(empSk).toBeDefined();
    expect(empSk).not.toHaveProperty('skillCategories');
  });

  it('GET /api/employees 视图 roles 化：多岗员工返回 roles 数组，不再有单值 role 键，退役 skills 不下发', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'roles-view-'));
    const skills = new FileSkillStore(join(dir, 'skills.json'));
    await skills.ensureSeed(); // 岗位白名单 = 分类 name 清单（seed 含 后端开发/前端开发）
    const store = new FileEmployeeStore(join(root, 'employees.json'));
    const h = createHandlers({ tasks, events, employeeStore: store, skills });
    // 新形状 payload：直接提交 roles 数组（normalizeEmployeeInput 原样透传）
    const created = await h({ method: 'POST', path: '/api/employees', body: {
      id: 'emp-multi', name: '多岗工', roles: ['后端开发', '前端开发'], capabilities: [], enabled: true,
    } });
    expect(created.status).toBe(201);
    const row = ((await h({ method: 'GET', path: '/api/employees' })).json as Array<Record<string, unknown>>)
      .find((e) => e.id === 'emp-multi')!;
    // 视图形状锁死：roles 原样数组下发；单值 role 键不复存在
    expect(row.roles).toEqual(['后端开发', '前端开发']);
    expect('role' in row).toBe(false);
    // 退役字段不再下发：store 分支视图移除 skills
    expect('skills' in row).toBe(false);
  });

  it('GET /api/employees 回退分支（无 employeeStore）roles 包装：单值 role 包装为单元素数组', async () => {
    const h = createHandlers({ tasks, events, employees: [{ id: 'emp-fb', name: '回退工', role: 'backend', skills: ['backend'] }] });
    const row = ((await h({ method: 'GET', path: '/api/employees' })).json as Array<Record<string, unknown>>)[0]!;
    expect(row.roles).toEqual(['backend']); // profiles 只读视图：role → roles 单元素包装
    expect('role' in row).toBe(false);
  });
});

describe('GET /api/tasks?claimedBy=&status= 过滤（2026-09-06 员工下钻，不传零回归）', () => {
  const yamlWithId = (taskId: string): string => `
taskId: ${taskId}
title: 过滤测试任务
repo: { url: "http://gitlab.inner.bank/x.git", branch: main }
tasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]
`;

  it('claimedBy + status 过滤命中；不传参数返回全量', async () => {
    const a = parseTaskPackage(yamlWithId('TASK-FILT-A'));
    const b = parseTaskPackage(yamlWithId('TASK-FILT-B'));
    await tasks.add(a, { draft: true });
    await tasks.add(b, { draft: true });
    await tasks.publish('TASK-FILT-A');
    await tasks.publish('TASK-FILT-B');
    await tasks.claim('TASK-FILT-A', 'emp-01');
    await tasks.finish('TASK-FILT-A', { status: 'done', reply: 'ok', turns: 1 }, true);

    const all = (await handle({ method: 'GET', path: '/api/tasks' })).json as unknown[];
    expect(all.length).toBe(2); // 不传参数：零回归，全量两条

    const mine = ((await handle({ method: 'GET', path: '/api/tasks', query: { claimedBy: 'emp-01', status: 'done,failed' } })).json) as Array<{ taskId: string; status: string }>;
    expect(mine.map((t) => t.taskId)).toEqual(['TASK-FILT-A']);
    expect(mine.every((t) => ['done', 'failed'].includes(t.status))).toBe(true);

    // 仅 status 过滤（pending 的 B）
    const pending = ((await handle({ method: 'GET', path: '/api/tasks', query: { status: 'pending' } })).json) as Array<{ taskId: string }>;
    expect(pending.map((t) => t.taskId)).toEqual(['TASK-FILT-B']);
  });
});

describe('未知路由', () => {
  it('→ 404', async () => {
    const res = await handle({ method: 'GET', path: '/api/unknown' });
    expect(res.status).toBe(404);
  });
});

describe('能力注册表 API（2026-09-05）', () => {
  /** 合法任务包 yaml（plan 模式）：第二项 kind 用参数替换 */
  function planYamlWithKind(kind: string): string {
    return [
      'taskId: TASK-PLAN-001',
      'title: 计划模式任务包',
      'repo:',
      '  url: http://gitlab.inner.bank/frontend/web-app.git',
      '  branch: feature/plan-run',
      'plan:',
      '  - id: t1',
      '    title: 第一步',
      '    detail: 阅读并修改代码',
      '  - id: t2',
      `    kind: ${kind}`,
      '    title: 第二步',
      '    detail: 部署到测试环境',
    ].join('\n');
  }

  it('GET /api/capabilities 返回 seed 四类；POST 新增；PUT 修改；DELETE 删除', async () => {
    const caps = new FileCapabilityStore(join(root, 'capabilities.json'));
    await caps.ensureSeed();
    const handle = createHandlers({ tasks, events, capabilities: caps });
    const seeded = await handle({ method: 'GET', path: '/api/capabilities' });
    expect(seeded.status).toBe(200);
    expect((seeded.json as CapabilityDef[]).map((c) => c.kind)).toEqual(['dev', 'test', 'commit', 'devops']);

    const created = await handle({ method: 'POST', path: '/api/capabilities',
      body: { kind: 'scan', name: '安全扫描', tools: { builtin: ['bash'], mcp: [] }, enabled: true } });
    expect(created.status).toBe(201);

    const updated = await handle({ method: 'PUT', path: '/api/capabilities/scan',
      body: { kind: 'scan', name: '安全扫描2', tools: { builtin: ['bash'], mcp: [] }, enabled: false } });
    expect(updated.status).toBe(200);
    expect((await handle({ method: 'GET', path: '/api/capabilities' })).json
      ).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'scan', enabled: false })]));

    expect((await handle({ method: 'DELETE', path: '/api/capabilities/scan' })).status).toBe(200);
    expect((await handle({ method: 'DELETE', path: '/api/capabilities/scan' })).status).toBe(404);
  });

  it('POST/PUT 非法 body 报 400 可读；未配置 capabilities 时 CRUD 返回 400', async () => {
    const noCapsHandle = createHandlers({ tasks, events });  // 无 capabilities
    expect((await noCapsHandle({ method: 'GET', path: '/api/capabilities' })).status).toBe(400);

    const caps = new FileCapabilityStore(join(root, 'capabilities.json'));
    await caps.ensureSeed();
    const handle2 = createHandlers({ tasks, events, capabilities: caps });
    const bad = await handle2({ method: 'POST', path: '/api/capabilities', body: { kind: 'x' } });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: string }).error).toMatch(/name 必须是非空字符串|tools 必须是对象/);
  });

  it('POST /api/tasks：plan 引用未注册/停用 kind 报 400 可读（缺省 dev 不校验白名单放行）', async () => {
    const caps = new FileCapabilityStore(join(root, 'capabilities.json'));
    await caps.ensureSeed();
    const handle = createHandlers({ tasks, events, capabilities: caps }); // seed 四类
    const bad = await handle({ method: 'POST', path: '/api/tasks', body: planYamlWithKind('devopsx') });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: string }).error).toMatch(/任务项 t2\.kind='devopsx' 未注册或已停用/);

    // 老 tasks 包零回归：不校验 kind，正常入库
    const legacy = await handle({ method: 'POST', path: '/api/tasks', body: await sampleYaml() });
    expect(legacy.status).toBe(201);
  });
});

describe('通知渠道 API（2026-09-06）', () => {
  const dingDef = { id: 'd1', type: 'dingtalk', name: '钉钉', webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=x', secret: 'SECxxx', enabled: true };
  const hookDef = { id: 'h1', type: 'webhook', name: '通用', webhookUrl: 'https://hook.local/notify', enabled: true };

  it('CRUD：GET / POST / PUT / DELETE；未注入 channels 时 400', async () => {
    const channels = new FileChannelStore(join(root, 'notification-channels.json'));
    const handle = createHandlers({ tasks, events, channels, consoleUrl: 'http://c.local' });

    const created = await handle({ method: 'POST', path: '/api/notification-channels', body: dingDef });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ id: 'd1' });

    const updated = await handle({ method: 'PUT', path: '/api/notification-channels/d1',
      body: { ...dingDef, enabled: false } });
    expect(updated.status).toBe(200);
    expect((await handle({ method: 'GET', path: '/api/notification-channels' })).json)
      .toEqual([expect.objectContaining({ id: 'd1', enabled: false })]);

    expect((await handle({ method: 'DELETE', path: '/api/notification-channels/d1' })).status).toBe(200);
    expect((await handle({ method: 'DELETE', path: '/api/notification-channels/d1' })).status).toBe(404);

    const noChannels = createHandlers({ tasks, events });
    expect((await noChannels({ method: 'GET', path: '/api/notification-channels' })).status).toBe(400);
    expect((await noChannels({ method: 'POST', path: '/api/notification-channels', body: dingDef })).status).toBe(400);
  });

  it('POST/PUT 非法 body 400 可读；PUT 路径 id 与 body.id 不一致 400', async () => {
    const channels = new FileChannelStore(join(root, 'notification-channels.json'));
    const handle = createHandlers({ tasks, events, channels });
    const bad = await handle({ method: 'POST', path: '/api/notification-channels',
      body: { id: 'x', type: 'dingtalk', name: '', webhookUrl: 'https://x', enabled: true } });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: string }).error).toContain('name');

    const mismatch = await handle({ method: 'PUT', path: '/api/notification-channels/d1', body: hookDef });
    expect(mismatch.status).toBe(400);
    expect((mismatch.json as { error: string }).error).toContain('不一致');
  });

  it('POST :id/test：stub fetch 2xx → sent；非 2xx → 502 回传失败原因；渠道不存在 404', async () => {
    const channels = new FileChannelStore(join(root, 'notification-channels.json'));
    const handle = createHandlers({ tasks, events, channels, consoleUrl: 'http://c.local' });
    await handle({ method: 'POST', path: '/api/notification-channels', body: hookDef });

    expect((await handle({ method: 'POST', path: '/api/notification-channels/nope/test' })).status).toBe(404);

    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init!.body as string });
      return { ok: true, status: 200 } as Response;
    });
    const sent = await handle({ method: 'POST', path: '/api/notification-channels/h1/test' });
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ id: 'h1', sent: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://hook.local/notify');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ type: 'test', taskId: 'test', consoleUrl: 'http://c.local' });

    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 } as Response));
    const failed = await handle({ method: 'POST', path: '/api/notification-channels/h1/test' });
    expect(failed.status).toBe(502);
    expect((failed.json as { error: string }).error).toContain('HTTP 503');
    vi.unstubAllGlobals();
  });

  it("secret 脱敏（终审安全修复）：GET 不回显明文；PUT 留空/'***' 保原 secret；新建缺省 secret 可空", async () => {
    const channels = new FileChannelStore(join(root, 'notification-channels.json'));
    const handle = createHandlers({ tasks, events, channels });

    // 新建：带 secret；无 secret 新建（钉钉加签可选）也成功
    expect((await handle({ method: 'POST', path: '/api/notification-channels', body: dingDef })).status).toBe(201);
    expect((await handle({ method: 'POST', path: '/api/notification-channels', body: hookDef })).status).toBe(201);

    // GET 脱敏：secret 回显 '***'，明文不出现在响应
    const rawList = JSON.stringify((await handle({ method: 'GET', path: '/api/notification-channels' })).json);
    expect(rawList).not.toContain('SECxxx');
    const listed = JSON.parse(rawList) as Array<{ id: string; secret?: string }>;
    expect(listed.find((c) => c.id === 'd1')!.secret).toBe('***');
    expect(listed.find((c) => c.id === 'h1')).not.toHaveProperty('secret');

    // PUT 留空保原 secret；'***' 同义
    expect((await handle({ method: 'PUT', path: '/api/notification-channels/d1',
      body: { ...dingDef, secret: '', name: '钉钉2' } })).status).toBe(200);
    expect((await handle({ method: 'PUT', path: '/api/notification-channels/d1',
      body: { ...dingDef, secret: '***', enabled: false } })).status).toBe(200);
    const stored = (await channels.list()).find((c) => c.id === 'd1')!;
    expect(stored.secret).toBe('SECxxx');                 // 库里仍是原 secret
    expect(stored.enabled).toBe(false);                   // 其余字段正常更新
    // PUT 带新 secret 直接更新
    expect((await handle({ method: 'PUT', path: '/api/notification-channels/d1',
      body: { ...dingDef, secret: 'SECnew' } })).status).toBe(200);
    expect((await channels.list()).find((c) => c.id === 'd1')!.secret).toBe('SECnew');
  });

  it('燕讯渠道（2026-09-10）：token 脱敏回显；PUT 留空保原 token；test 端点透传 yanxun 配置且校验业务码', async () => {
    const channels = new FileChannelStore(join(root, 'notification-channels.json'));
    const yx = {
      apiUrl: 'http://170.200.34.70:8199/api/message/sendRobotText',
      head: { serviceCode: '50022000009', serviceScene: '11', lglBrId: '001', consumerId: '0251', orgConsumerId: '0251', channelTyp: 'CH0540', filFlg: '0' },
    };
    const yxDef = { id: 'y1', type: 'yanxun', name: '燕讯', webhookUrl: '', token: 'tok-secret', enabled: true };
    const handle = createHandlers({ tasks, events, channels, yanxun: yx });

    // 新建 + token 必填校验（不校验 webhookUrl）
    expect((await handle({ method: 'POST', path: '/api/notification-channels',
      body: { ...yxDef, token: '' } })).status).toBe(400);
    expect((await handle({ method: 'POST', path: '/api/notification-channels', body: yxDef })).status).toBe(201);

    // GET 脱敏：token 回显 '***'，明文不出现
    const rawList = JSON.stringify((await handle({ method: 'GET', path: '/api/notification-channels' })).json);
    expect(rawList).not.toContain('tok-secret');
    expect(JSON.parse(rawList)).toEqual([expect.objectContaining({ id: 'y1', token: '***' })]);

    // PUT 留空/'***' 保原 token（同 secret 模式）
    expect((await handle({ method: 'PUT', path: '/api/notification-channels/y1',
      body: { ...yxDef, token: '', name: '燕讯2' } })).status).toBe(200);
    expect((await channels.list()).find((c) => c.id === 'y1')!.token).toBe('tok-secret');

    // test 端点：fetch 到 yanxun.apiUrl + 报文形状正确；returnStatus=F → 502 带 returnCode
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      bodies.push(`${url}|${init!.body as string}`);
      return { ok: true, status: 200, json: async () => ({ responseHead: { returnStatus: 'F', ret: [{ returnCode: '999992', returnMsg: 'ip 不在白名单' }] } }) } as unknown as Response;
    });
    const failed = await handle({ method: 'POST', path: '/api/notification-channels/y1/test' });
    expect(failed.status).toBe(502);
    expect((failed.json as { error: string }).error).toContain('999992');
    // 燕讯测试消息已改纯文本自检文案（2026-09-11 实测渠道不渲染 markdown），报文不再含表格竖线，
    // 恢复简单的 split('|') 切 URL 与报文体
    const [url, body] = bodies[0]!.split('|');
    expect(url).toBe(yx.apiUrl);
    const parsed = JSON.parse(body!) as { requestHead: Record<string, string>; requestBody: Record<string, unknown> };
    expect(parsed.requestHead.serviceCode).toBe('50022000009');
    expect(parsed.requestBody.token).toBe('tok-secret');
    expect(parsed.requestBody.appCode).toBe('0251');               // 测试消息无员工 → 回退 consumerId
    vi.unstubAllGlobals();
  });
});

describe('能力工具来源元数据与 MCP server 清单（2026-09-06 用户需求 A+B）', () => {
  /** 假 hub：两个「已注册」server 名（statuses 用最小桩） */
  const fakeHub = {
    serverNames: () => ['gitlab-mcp', 'ci-mcp'],
    toolsFor: () => [],
    statuses: () => [
      { name: 'gitlab-mcp', status: 'connected' as const, tools: ['mcp_gitlab-mcp_ping'] },
      { name: 'ci-mcp', status: 'error' as const, error: 'connection refused', tools: [] },
    ],
  };

  it('GET /api/capabilities/meta：无 hub = 内置包；有 hub = 内置 + server 名', async () => {
    const h1 = createHandlers({ tasks, events });
    const meta1 = (await h1({ method: 'GET', path: '/api/capabilities/meta' })).json as Record<string, string[]>;
    expect(meta1.builtin).toEqual(['bash', 'files']);
    expect(meta1.mcp).toEqual(['forge', 'deploy']);

    const h2 = createHandlers({ tasks, events, mcpHub: fakeHub });
    const meta2 = (await h2({ method: 'GET', path: '/api/capabilities/meta' })).json as Record<string, string[]>;
    expect(meta2.mcp).toEqual(['forge', 'deploy', 'gitlab-mcp', 'ci-mcp']);
  });

  it('GET /api/mcp-servers：无 hub = 空数组（空注册表是正常态）；有 hub = 状态清单', async () => {
    const h1 = createHandlers({ tasks, events });
    expect((await h1({ method: 'GET', path: '/api/mcp-servers' })).json).toEqual([]);

    const h2 = createHandlers({ tasks, events, mcpHub: fakeHub });
    const servers = (await h2({ method: 'GET', path: '/api/mcp-servers' })).json as Array<{ name: string; status: string }>;
    expect(servers).toHaveLength(2);
    expect(servers.find((s) => s.name === 'gitlab-mcp')!.status).toBe('connected');
    expect(servers.find((s) => s.name === 'ci-mcp')!.status).toBe('error');
  });

  it('能力 upsert 校验动态化：mcp 含已注册 server 名放行，未知标识仍 400', async () => {
    const store = new FileCapabilityStore(join(root, 'cap.json'),
      () => new Set([...KNOWN_MCP_PACKS, 'gitlab-mcp', 'ci-mcp'])); // store 层同源动态白名单
    const h = createHandlers({ tasks, events, capabilities: store, mcpHub: fakeHub });
    const def = { kind: 'ops', name: '运维', tools: { builtin: [], mcp: ['gitlab-mcp'] }, enabled: true };
    expect((await h({ method: 'POST', path: '/api/capabilities', body: def })).status).toBe(201);

    const bad = { ...def, kind: 'ops2', tools: { builtin: [], mcp: ['no-such-server'] } };
    const res = await h({ method: 'POST', path: '/api/capabilities', body: bad });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('no-such-server');
  });
});

describe('Skill 库 API（2026-09-06）', () => {
  const SKILL = {
    categoryId: 'backend', name: '接口异常码规范', description: 'REST 异常码约定',
    type: 'knowledge' as const, content: '所有接口异常码以 E 开头',
  };

  // 独立 tmp 文件，避免污染共享 root（每个用例新 store，串行队列互不影响）
  const makeSkillDeps = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skills-'));
    return new FileSkillStore(join(dir, 'skills.json'));
  };

  it('未注入 skillStore：400 未启用', async () => {
    const h = createHandlers({ tasks, events });
    const res = await h({ method: 'GET', path: '/api/skills' });
    expect(res.status).toBe(400);
  });

  it('分类 CRUD：seed 后 GET 内置五类；POST 新增；DELETE 挂载 409/不存在 404', async () => {
    const skills = await makeSkillDeps();
    const h = createHandlers({ tasks, events, skills });
    await skills.ensureSeed();
    const list = await h({ method: 'GET', path: '/api/skill-categories' });
    expect((list.json as { id: string }[]).map((c) => c.id)).toContain('backend');

    const created = await h({ method: 'POST', path: '/api/skill-categories', body: { id: 'data', name: '数据开发' } });
    expect(created.status).toBe(201);

    await h({ method: 'POST', path: '/api/skills', body: SKILL });
    const mounted = await h({ method: 'DELETE', path: '/api/skill-categories/backend' });
    expect(mounted.status).toBe(409);
    const missing = await h({ method: 'DELETE', path: '/api/skill-categories/nope' });
    expect(missing.status).toBe(404);
    const okDel = await h({ method: 'DELETE', path: '/api/skill-categories/data' });
    expect(okDel.status).toBe(200);
  });

  it('分类 POST 重名 → 409（name 业务键，2026-09-07 岗位即分类）', async () => {
    const skills = await makeSkillDeps();
    const h = createHandlers({ tasks, events, skills });
    await skills.ensureSeed();
    // 首次新增 name「测试岗」（不与内置 seed 撞名）→ 201
    const first = await h({ method: 'POST', path: '/api/skill-categories', body: { id: 'cat-a', name: '测试岗' } });
    expect(first.status).toBe(201);
    // 不同 id、同 name → 409（name 是业务键，与 store 精确 === 口径一致，HTTP 层不做 trim 归一）
    const res = await h({ method: 'POST', path: '/api/skill-categories', body: { id: 'cat-b', name: '测试岗' } });
    expect(res.status).toBe(409);
    expect((res.json as { error: string }).error).toMatch(/已存在/);
  });

  it('skill POST：201 pending + 自动 id；校验失败 400', async () => {
    const skills = await makeSkillDeps();
    const h = createHandlers({ tasks, events, skills });
    await skills.ensureSeed(); // 对齐生产接线（server.ts 首启 seed）：categoryId 白名单校验依赖内置分类
    const res = await h({ method: 'POST', path: '/api/skills', body: SKILL });
    expect(res.status).toBe(201);
    const body = res.json as { id: string; status: string };
    expect(body.status).toBe('pending');
    expect(body.id).toMatch(/^skill-/);
    expect((await skills.listSkills({ status: 'pending' })).length).toBe(1);

    const bad = await h({ method: 'POST', path: '/api/skills', body: { ...SKILL, categoryId: 'nope' } });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: string }).error).toContain('categoryId');

    const esc = await h({ method: 'POST', path: '/api/skills', body: { ...SKILL, type: 'asset', assetFiles: [{ path: '../x.sh', content: 'x' }] } });
    expect(esc.status).toBe(400);
    expect((esc.json as { error: string }).error).toContain('..');
  });

  it('skill POST 客户端自供 id（终审 I3）：已存在 → 409；新 id → 201 沿用', async () => {
    const skills = await makeSkillDeps();
    const h = createHandlers({ tasks, events, skills });
    await skills.ensureSeed();
    // 自供已存在 id → 409（此前会被静默覆盖）
    const dup = await h({ method: 'POST', path: '/api/skills', body: { ...SKILL, id: 'skill-exist1' } });
    expect(dup.status).toBe(201);
    const conflict = await h({ method: 'POST', path: '/api/skills', body: { ...SKILL, id: 'skill-exist1', name: '覆盖者' } });
    expect(conflict.status).toBe(409);
    expect((conflict.json as { error: string }).error).toContain('skill-exist1');
    // 原记录未被覆盖
    expect((await skills.getSkill('skill-exist1'))?.name).not.toBe('覆盖者');
    // 自供全新 id → 201 且沿用该 id
    const fresh = await h({ method: 'POST', path: '/api/skills', body: { ...SKILL, id: 'skill-fresh9' } });
    expect(fresh.status).toBe(201);
    expect((fresh.json as { id: string }).id).toBe('skill-fresh9');
  });

  it('skill PUT：可编辑但 status/source/createdAt/reviewedAt/sourceTaskId 保留原值；type 改非 asset 清空 assetFiles', async () => {
    const skills = await makeSkillDeps();
    const h = createHandlers({ tasks, events, skills });
    await skills.ensureSeed(); // 对齐生产接线：categoryId 白名单校验依赖内置分类
    // asset skill 走 review approve 产生 reviewedAt，再验证 PUT 不篡改终审痕迹（终审 T2①/M2）
    const created = await h({ method: 'POST', path: '/api/skills', body: { ...SKILL, type: 'asset', assetFiles: [{ path: 'run.sh', content: 'echo' }] } });
    const id = (created.json as { id: string }).id;
    await h({ method: 'POST', path: `/api/skills/${id}/review`, body: { action: 'approve' } });

    // type 改为 knowledge：assetFiles 强制清空（终审 T8①，防删空行后旧文件清单残留）
    const res = await h({ method: 'PUT', path: `/api/skills/${id}`, body: { ...SKILL, name: '改名', status: 'approved' } });
    expect(res.status).toBe(200);
    const stored = await skills.getSkill(id);
    expect(stored?.name).toBe('改名');
    expect(stored?.status).toBe('approved'); // status 不可经 PUT 篡改
    expect(stored?.type).toBe('knowledge');
    expect(stored?.assetFiles).toBeUndefined();
    expect(stored?.reviewedAt).toBeGreaterThan(0); // 终审痕迹保留
    // 恶意携带 sourceTaskId 也不生效
    await h({ method: 'PUT', path: `/api/skills/${id}`, body: { ...SKILL, name: '改名2', sourceTaskId: 'T-EVIL' } });
    expect((await skills.getSkill(id))?.sourceTaskId).toBeUndefined();
  });

  it('skill review：approve/reject/改判；action 非法 400；不存在 404', async () => {
    const skills = await makeSkillDeps();
    const h = createHandlers({ tasks, events, skills });
    await skills.ensureSeed(); // 对齐生产接线：categoryId 白名单校验依赖内置分类
    const created = await h({ method: 'POST', path: '/api/skills', body: SKILL });
    const id = (created.json as { id: string }).id;

    const ok1 = await h({ method: 'POST', path: `/api/skills/${id}/review`, body: { action: 'approve' } });
    expect(ok1.json).toMatchObject({ status: 'approved' });
    const ok2 = await h({ method: 'POST', path: `/api/skills/${id}/review`, body: { action: 'reject' } });
    expect(ok2.json).toMatchObject({ status: 'rejected' }); // 允许改判
    const bad = await h({ method: 'POST', path: `/api/skills/${id}/review`, body: { action: 'hack' } });
    expect(bad.status).toBe(400);
    const missing = await h({ method: 'POST', path: '/api/skills/nope/review', body: { action: 'approve' } });
    expect(missing.status).toBe(404);
  });

  it('skill GET 过滤：status/categoryId/q', async () => {
    const skills = await makeSkillDeps();
    const h = createHandlers({ tasks, events, skills });
    await skills.ensureSeed(); // 对齐生产接线：categoryId 白名单校验依赖内置分类
    await h({ method: 'POST', path: '/api/skills', body: SKILL });
    await h({ method: 'POST', path: '/api/skills', body: { ...SKILL, name: '前端规范', categoryId: 'frontend', description: '组件与样式规范' } });
    const byCat = await h({ method: 'GET', path: '/api/skills', query: { categoryId: 'frontend' } });
    expect((byCat.json as { name: string }[]).map((s) => s.name)).toEqual(['前端规范']);
    const byQ = await h({ method: 'GET', path: '/api/skills', query: { q: '异常码' } });
    expect((byQ.json as unknown[]).length).toBe(1);
  });

  it('Skill/岗位 CRUD 落 config_change 审计（2026-09-11 复盘批：留痕补盲区）', async () => {
    const skills = await makeSkillDeps();
    const h = createHandlers({ tasks, events, skills });
    await skills.ensureSeed();
    const OP = '王五';
    // 走一遍增/改/删（Skill + 岗位），失败的操作（404/409）不应留痕
    const created = await h({ method: 'POST', path: '/api/skills', body: SKILL, operator: OP });
    const id = (created.json as { id: string }).id;
    await h({ method: 'PUT', path: `/api/skills/${id}`, body: { ...SKILL, name: '改名' }, operator: OP });
    await h({ method: 'DELETE', path: '/api/skills/nope', operator: OP }); // 404 不留痕
    await h({ method: 'DELETE', path: `/api/skills/${id}`, operator: OP });
    await h({ method: 'POST', path: '/api/skill-categories', body: { id: 'cat-x', name: '审计岗' }, operator: OP });
    await h({ method: 'DELETE', path: '/api/skill-categories/nope', operator: OP }); // 404 不留痕
    await h({ method: 'DELETE', path: '/api/skill-categories/cat-x', operator: OP });

    const cfgEvents = (await events.list()).filter((e) => e.type === 'config_change');
    expect(cfgEvents.map((e) => e.summary)).toEqual([
      `新建 Skill：${id}（接口异常码规范）（王五）`,
      `修改 Skill：${id}（改名）（王五）`,
      `删除 Skill：${id}（改名）（王五）`,
      '新增岗位：cat-x（审计岗）（王五）',
      '删除岗位：cat-x（王五）',
    ]);
    expect(cfgEvents[0]).toMatchObject({ taskId: 'console', employeeId: 'console' });
  });
});

describe('POST /api/tasks/:id/checks/:item/void（作废失效待审，2026-09-11 P1 治理批）', () => {
  /** 造一条待审：任务非执行中（pending）→ 申报即失效（expired）；返回 handle 与任务 id */
  const seedExpiredCheck = async (): Promise<{ h: typeof handle; taskId: string }> => {
    const yaml = (await sampleYaml()).replace('taskId: TASK-2026-0912-001', 'taskId: TASK-VOID-1');
    await handle({ method: 'POST', path: '/api/tasks', body: yaml });
    // draft 发布到 pending——pending 不是执行中，待审即失效（放行必 404 的幽灵场景）
    await handle({ method: 'POST', path: '/api/tasks/TASK-VOID-1/publish', body: {} });
    await events.append({
      id: 'ev-check-1', ts: 1000, taskId: 'TASK-VOID-1', employeeId: 'emp-01',
      type: 'task_check', summary: '申报节点', payload: { item: 'item-1', result: '自检通过', awaiting: true },
    });
    return { h: handle, taskId: 'TASK-VOID-1' };
  };

  it('失效待审可作废：intervention(voided) 留痕 + operator；历史视图已作废清待', async () => {
    const { h } = await seedExpiredCheck();
    const res = await h({
      method: 'POST', path: '/api/tasks/TASK-VOID-1/checks/item-1/void', body: {},
      operator: '张三',
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ taskId: 'TASK-VOID-1', item: 'item-1', voided: true });

    // 留痕进了审计链（推导链据此清待）
    const intervention = (await events.list()).find((e) => e.type === 'intervention');
    expect(intervention?.payload).toMatchObject({ item: 'item-1', voided: true, operator: '张三' });

    const history = await h({ method: 'GET', path: '/api/checks/history' });
    expect((history.json as { voided?: boolean; pending: boolean }[])[0]).toMatchObject({ pending: false, voided: true });

    // 待审列表（角标口径）不再包含
    const pending = await h({ method: 'GET', path: '/api/checks' });
    expect((pending.json as unknown[]).length).toBe(0);
  });

  it('已裁决后再作废 409；执行中任务的待审 409（仍走放行/驳回）；不存在 404', async () => {
    const { h } = await seedExpiredCheck();
    await h({ method: 'POST', path: '/api/tasks/TASK-VOID-1/checks/item-1/void', body: {} });
    const again = await h({ method: 'POST', path: '/api/tasks/TASK-VOID-1/checks/item-1/void', body: {} });
    expect(again.status).toBe(409);
    expect((again.json as { error: string }).error).toContain('已作废');

    // 执行中任务的待审：作废会把 resolver 卡死到看门狗超时——必须 409 引导走放行/驳回
    const yaml = (await sampleYaml()).replace('taskId: TASK-2026-0912-001', 'taskId: TASK-VOID-2');
    await handle({ method: 'POST', path: '/api/tasks', body: yaml });
    await handle({ method: 'POST', path: '/api/tasks/TASK-VOID-2/publish', body: {} });
    await tasks.claim('TASK-VOID-2', 'emp-01');
    await tasks.markRunning('TASK-VOID-2');
    await events.append({
      id: 'ev-check-2', ts: 2000, taskId: 'TASK-VOID-2', employeeId: 'emp-01',
      type: 'task_check', summary: '申报节点', payload: { item: 'item-9', result: '自检通过', awaiting: true },
    });
    const live = await h({ method: 'POST', path: '/api/tasks/TASK-VOID-2/checks/item-9/void', body: {} });
    expect(live.status).toBe(409);
    expect((live.json as { error: string }).error).toContain('执行中');

    const missing = await h({ method: 'POST', path: '/api/tasks/TASK-VOID-2/checks/item-nope/void', body: {} });
    expect(missing.status).toBe(404);
  });
});

describe('GET /api/audit 完整性附带 + POST /api/audit/verify（2026-09-11 P1 治理批）', () => {
  it('未校验过不附带；verify 后附带最近结果且即时重算生效', async () => {
    await events.append({
      id: 'e1', ts: 1000, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: 's',
    });
    const monitor = new IntegrityMonitor(events);
    const h = createHandlers({ tasks, events, integrityMonitor: monitor });

    // 未跑过校验：响应无 lastIntegrity 字段
    const before = await h({ method: 'GET', path: '/api/audit' });
    expect((before.json as Record<string, unknown>).lastIntegrity).toBeUndefined();

    // 立即校验：返回结果并驻内存
    const verify = await h({ method: 'POST', path: '/api/audit/verify', body: {} });
    expect(verify.status).toBe(200);
    expect((verify.json as { ok: boolean; total: number })).toMatchObject({ ok: true, total: 1 });

    const after = await h({ method: 'GET', path: '/api/audit' });
    expect((after.json as { lastIntegrity?: { ok: boolean } }).lastIntegrity).toMatchObject({ ok: true, total: 1 });
  });

  it('未注入监控器：POST verify 400（未启用）；GET 不附带', async () => {
    const verify = await handle({ method: 'POST', path: '/api/audit/verify', body: {} });
    expect(verify.status).toBe(400);
    const list = await handle({ method: 'GET', path: '/api/audit' });
    expect((list.json as Record<string, unknown>).lastIntegrity).toBeUndefined();
  });
});
