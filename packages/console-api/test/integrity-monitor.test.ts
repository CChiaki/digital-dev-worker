import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileEventStore } from '../src/stores/index.js';
import { IntegrityMonitor } from '../src/team/integrity-monitor.js';
import type { EventStore } from '../src/stores/index.js';
import type { AgentEvent } from '@ddw/runtime';

const ev = (id: string, ts: number): AgentEvent => ({
  id, ts, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: id,
});

describe('IntegrityMonitor（审计链定时校验，2026-09-11 P1 治理批）', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddw-integrity-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('verifyNow 通过：结果驻内存（last），ok=true', async () => {
    const events = new FileEventStore(dir);
    await events.append(ev('e1', 1000));
    await events.append(ev('e2', 2000));

    const onFail = vi.fn();
    const monitor = new IntegrityMonitor(events, onFail);
    const s = await monitor.verifyNow();
    expect(s).toMatchObject({ ok: true, total: 2 });
    expect(s.at).toBeGreaterThan(0);
    expect(monitor.last()).toMatchObject({ ok: true, total: 2 });
    expect(onFail).not.toHaveBeenCalled();
  });

  it('verifyNow 断链：ok=false 触发 onFail 告警（携带 brokenAt），last 更新', async () => {
    const events = new FileEventStore(dir);
    await events.append(ev('e1', 1000));
    await events.append(ev('e2', 2000));

    // 篡改 e2 落盘（同 stores.contract 的 file tamper 手法）
    const jsonl = join(dir, 'events.jsonl');
    const lines = (await readFile(jsonl, 'utf8')).split('\n').filter(Boolean);
    const evil = JSON.parse(lines[1]!);
    evil.summary = '被篡改';
    lines[1] = JSON.stringify(evil);
    await writeFile(jsonl, lines.join('\n') + '\n', 'utf8');

    const onFail = vi.fn();
    const monitor = new IntegrityMonitor(events, onFail);
    const s = await monitor.verifyNow();
    expect(s.ok).toBe(false);
    expect(s.brokenAt).toBe('e2');
    expect(monitor.last()!.ok).toBe(false);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledWith(expect.objectContaining({ ok: false, brokenAt: 'e2' }));
  });

  it('无 verifyIntegrity 能力的桩存储：start 空转、verifyNow 抛可读错误', async () => {
    const stub = { append: async () => {}, list: async () => [] as AgentEvent[] } as unknown as EventStore;
    const monitor = new IntegrityMonitor(stub);
    monitor.start(); // 不装定时器、不抛错
    monitor.stop();
    expect(monitor.last()).toBeUndefined();
    await expect(monitor.verifyNow()).rejects.toThrow(/不支持完整性校验/);
  });

  it('start/stop 幂等（重复调用无害）', async () => {
    const events = new FileEventStore(dir);
    await events.append(ev('e1', 1000));
    const monitor = new IntegrityMonitor(events, undefined, 86_400_000);
    monitor.start();
    monitor.start(); // 幂等：不重复装定时器
    monitor.stop();
    monitor.stop();
    // 停止后 last 仍可读（驻内存值不随 stop 清除）
    expect(monitor.last()).toBeUndefined(); // 未跑过 verifyNow
  });
});
