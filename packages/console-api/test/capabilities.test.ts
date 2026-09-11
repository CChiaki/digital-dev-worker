import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCapabilityStore, CAPABILITY_PRESETS } from '../src/team/capabilities.js';

const tmp = async (): Promise<string> => await mkdtemp(join(tmpdir(), 'caps-'));

describe('FileCapabilityStore（能力注册表，2026-09-05）', () => {
  it('ensureSeed 首启写入四类预置；幂等（已有内容不覆盖）', async () => {
    const dir = await tmp();
    try {
      const store = new FileCapabilityStore(join(dir, 'capabilities.json'));
      await store.ensureSeed();
      const list = await store.list();
      expect(list.map((c) => c.kind)).toEqual(['dev', 'test', 'commit', 'devops']);
      expect(list.find((c) => c.kind === 'devops')?.tools.mcp).toEqual(['deploy']);
      await store.upsert({ ...CAPABILITY_PRESETS[0]!, name: '开发编码改', enabled: false });
      await store.ensureSeed();  // 二次 seed 不覆盖用户修改
      expect((await store.list()).find((c) => c.kind === 'dev')?.name).toBe('开发编码改');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('upsert 新增与修改；remove 删除；list 排序稳定', async () => {
    const dir = await tmp();
    try {
      const store = new FileCapabilityStore(join(dir, 'capabilities.json'));
      await store.ensureSeed();
      await store.upsert({ kind: 'scan', name: '安全扫描', tools: { builtin: ['bash'], mcp: [] }, enabled: true });
      expect((await store.list()).map((c) => c.kind)).toContain('scan');
      await store.upsert({ kind: 'scan', name: '安全扫描2', tools: { builtin: ['bash'], mcp: [] }, enabled: false });
      expect((await store.list()).find((c) => c.kind === 'scan')?.enabled).toBe(false);
      expect(await store.remove('scan')).toBe(true);
      expect(await store.remove('scan')).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('损坏文件不静默降级：list rejects、upsert rejects 不落盘覆盖（2026-09-05 修复轮次）', async () => {
    const dir = await tmp();
    try {
      const filePath = join(dir, 'capabilities.json');
      await writeFile(filePath, '{"broken', 'utf8');
      const store = new FileCapabilityStore(filePath);
      await expect(store.list()).rejects.toThrow();
      // 写路径同样拒绝：不得把残缺读结果当作空表缓存并覆盖写回
      await expect(store.upsert({ kind: 'dev', name: '覆盖尝试', tools: { builtin: ['bash'], mcp: [] }, enabled: true }))
        .rejects.toThrow();
      await expect(readFile(filePath, 'utf8')).resolves.toBe('{"broken');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('ensureSeed 探测非 ENOENT 错误上抛：损坏文件不被预置覆盖（补修轮次）', async () => {
    const dir = await tmp();
    try {
      const filePath = join(dir, 'capabilities.json');
      await writeFile(filePath, '{"broken', 'utf8');
      const store = new FileCapabilityStore(filePath);
      await expect(store.ensureSeed()).rejects.toThrow();
      // 不得静默覆盖写预置
      await expect(readFile(filePath, 'utf8')).resolves.toBe('{"broken');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('文件为合法 JSON 但非数组：list rejects 且提示格式错误（补修轮次）', async () => {
    const dir = await tmp();
    try {
      const filePath = join(dir, 'capabilities.json');
      await writeFile(filePath, '{}', 'utf8');
      const store = new FileCapabilityStore(filePath);
      await expect(store.list()).rejects.toThrow(/能力注册表文件格式错误/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('upsert 校验：kind/name 非空、tools.builtin/mcp 须为字符串数组（mcp 仅允许 forge/deploy）', async () => {
    const dir = await tmp();
    try {
      const store = new FileCapabilityStore(join(dir, 'capabilities.json'));
      await expect(store.upsert({ kind: '', name: 'x', tools: { builtin: [], mcp: [] }, enabled: true }))
        .rejects.toThrow(/kind 必须是非空字符串/);
      await expect(store.upsert({ kind: 'k', name: '', tools: { builtin: [], mcp: [] }, enabled: true }))
        .rejects.toThrow(/name 必须是非空字符串/);
      await expect(store.upsert({ kind: 'k', name: 'n', tools: { builtin: 'bash', mcp: [] } as never, enabled: true }))
        .rejects.toThrow(/tools\.builtin 必须是字符串数组/);
      await expect(store.upsert({ kind: 'k', name: 'n', tools: { builtin: [], mcp: ['nope'] }, enabled: true }))
        .rejects.toThrow(/tools\.mcp 含未注册的工具包/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
