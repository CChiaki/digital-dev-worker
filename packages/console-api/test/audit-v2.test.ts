import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createHandlers } from '../src/http/handlers.js';
import { FileTaskStore, FileEventStore } from '../src/stores/index.js';
import type { AgentEvent } from '@ddw/runtime';

let root: string;
let handle: ReturnType<typeof createHandlers>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-audit2-'));
  handle = createHandlers({ tasks: new FileTaskStore(root), events: new FileEventStore(root) });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ev = (id: string, over: Partial<AgentEvent>): AgentEvent => ({
  id, ts: 1000, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: 'x', ...over,
});

describe('审计台账 v2：GET /api/audit/:taskId 任务级聚合', () => {
  it('聚合任务状态 + 时间线 + 工具调用统计 + 结果', async () => {
    // 准备：入库任务
    const yaml = await readFile(new URL('../../../examples/task-package.example.yaml', import.meta.url), 'utf8');
    const created = await handle({ method: 'POST', path: '/api/tasks', body: yaml });
    const taskId = (created.json as { taskId: string }).taskId;
    await handle({ method: 'POST', path: `/api/tasks/${taskId}/publish`, body: {} });
    await handle({ method: 'POST', path: `/api/tasks/${taskId}/claim`, body: { employeeId: 'emp-01' } });
    await handle({
      method: 'POST', path: `/api/tasks/${taskId}/finish`,
      body: { outcome: { status: 'done', reply: 'MR !42 已创建', turns: 5 }, ok: true },
    });

    // 事件：3 个工具（1 个失败）+ 2 个思考 + 1 次介入
    let ts = 1000;
    const append = async (e: AgentEvent) => { e.ts = ++ts * 1000; await new FileEventStore(root).append(e); };
    await append(ev('a', { taskId, type: 'thinking', summary: '分析简报' }));
    await append(ev('b', { taskId, type: 'tool_call', summary: 'gitlab_create_branch', payload: { isError: false } }));
    await append(ev('c', { taskId, type: 'tool_call', summary: 'gitlab_commit_files', payload: { isError: false } }));
    await append(ev('d', { taskId, type: 'tool_call', summary: 'gitlab_commit_files', payload: { isError: true } }));
    await append(ev('e', { taskId, type: 'intervention', summary: '优先 T-1' }));
    await append(ev('f', { taskId, type: 'thinking', summary: '重试提交' }));

    const res = await handle({ method: 'GET', path: `/api/audit/${taskId}` });
    expect(res.status).toBe(200);
    const body = res.json as {
      task: { status: string };
      timeline: AgentEvent[];
      toolCalls: { name: string; count: number; errors: number }[];
      reply?: string;
    };
    expect(body.task.status).toBe('done');
    expect(body.reply).toBe('MR !42 已创建');
    expect(body.timeline.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(body.toolCalls).toEqual([
      { name: 'gitlab_create_branch', count: 1, errors: 0 },
      { name: 'gitlab_commit_files', count: 2, errors: 1 },
    ]);
  });

  it('不存在的任务 → 404', async () => {
    const res = await handle({ method: 'GET', path: '/api/audit/NOPE' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/audit?integrity=1 —— 审计 hash 链校验端点', () => {
  it('全链完整 → integrity ok；带 integrity 参数时才校验', async () => {
    const ev = (id: string, ts: number): AgentEvent => ({
      id, ts, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: id,
    });
    const store = new FileEventStore(root);
    await store.append(ev('e1', 1000));
    await store.append(ev('e2', 2000));

    const withCheck = await handle({ method: 'GET', path: '/api/audit', query: { integrity: '1' } });
    expect((withCheck.json as { integrity: { ok: boolean; total: number } }).integrity).toEqual({ ok: true, total: 2 });

    const noCheck = await handle({ method: 'GET', path: '/api/audit' });
    expect((noCheck.json as { integrity?: unknown }).integrity).toBeUndefined();
  });

  it('事件被篡改 → integrity ok=false 且 brokenAt 定位', async () => {
    const store = new FileEventStore(root);
    await store.append({ id: 'e1', ts: 1000, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: 'x' });
    await store.append({ id: 'e2', ts: 2000, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: 'y' });

    // 直接改盘上第二行的 summary（绕过 store 模拟篡改）
    const jsonl = join(root, 'events.jsonl');
    const lines = (await readFile(jsonl, 'utf8')).split('\n').filter(Boolean);
    const evil = JSON.parse(lines[1]!);
    evil.summary = '被篡改';
    lines[1] = JSON.stringify(evil);
    await writeFile(jsonl, lines.join('\n') + '\n', 'utf8');

    const res = await handle({ method: 'GET', path: '/api/audit', query: { integrity: '1' } });
    expect((res.json as { integrity: { ok: boolean; brokenAt?: string } }).integrity).toEqual({
      ok: false, total: 2, brokenAt: 'e2',
    });
  });
});
