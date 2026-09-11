import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepWorkspaces } from '../src/team/retention.js';

const DAY = 86_400_000;

/** 目录 mtime 伪造：设为 days 天前（清扫判定只看任务目录自身 mtime） */
async function age(path: string, days: number): Promise<void> {
  const t = new Date(Date.now() - days * DAY);
  await utimes(path, t, t);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 造一个任务目录（含一个文件，防空目录语义歧义） */
async function mkTaskDir(root: string, segs: string[]): Promise<string> {
  const p = join(root, ...segs);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, 'f.txt'), 'x');
  return p;
}

describe('sweepWorkspaces（磁盘治理，2026-09-11 P1 治理批）', () => {
  let dir: string;
  let workspaceRoot: string;
  let sessionsRoot: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-retention-'));
    workspaceRoot = join(dir, 'ws');
    sessionsRoot = join(dir, 'ss');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('超期任务目录删除（workspace + sessions）、活跃目录保留；返回被删清单', async () => {
    const oldWs = await mkTaskDir(workspaceRoot, ['emp-01', 'TASK-OLD']);
    const newWs = await mkTaskDir(workspaceRoot, ['emp-01', 'TASK-NEW']);
    const oldSs = await mkTaskDir(sessionsRoot, ['emp-01', 'tasks', 'TASK-OLD']);
    const newSs = await mkTaskDir(sessionsRoot, ['emp-01', 'tasks', 'TASK-NEW']);
    await age(oldWs, 10);
    await age(oldSs, 10);

    const removed = await sweepWorkspaces({ workspaceRoot, sessionsRoot }, 7);
    expect(removed).toContain('emp-01/TASK-OLD');
    expect(removed).toContain('emp-01/tasks/TASK-OLD');
    await expect(exists(oldWs)).resolves.toBe(false);
    await expect(exists(oldSs)).resolves.toBe(false);
    // mtime 新于 TTL 的不动（活跃任务安全）
    await expect(exists(newWs)).resolves.toBe(true);
    await expect(exists(newSs)).resolves.toBe(true);
  });

  it('sessions/<emp>/sessions 会话索引目录不在任务粒度，不动（红线）', async () => {
    // 会话索引与任务目录平级但非 per-task（retention.ts:69 注释约定）——误删会破坏历史会话回放
    const idx = await mkTaskDir(sessionsRoot, ['emp-01', 'sessions', 's1']);
    await age(idx, 30);
    await mkTaskDir(sessionsRoot, ['emp-01', 'tasks', 'TASK-X']);

    const removed = await sweepWorkspaces({ workspaceRoot, sessionsRoot }, 7);
    expect(removed.some((r) => r.includes('/sessions/'))).toBe(false);
    await expect(exists(idx)).resolves.toBe(true);
  });

  it('days <= 0 空转（配置关闭语义）；root 不存在不抛', async () => {
    await mkTaskDir(workspaceRoot, ['emp-01', 'TASK-A']);

    expect(await sweepWorkspaces({ workspaceRoot, sessionsRoot }, 0)).toEqual([]);
    await expect(sweepWorkspaces({ workspaceRoot: join(dir, 'nope'), sessionsRoot: join(dir, 'nope2') }, 7))
      .resolves.toEqual([]);
  });
});
