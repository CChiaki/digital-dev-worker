import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRoster } from '../src/team/managed-roster.js';
import { FileEmployeeStore, type EmployeeRecord } from '../src/team/employee-store.js';
import type { TaskRecord } from '../src/stores/index.js';

const rec = (id: string, capabilities: string[], enabled = true): EmployeeRecord => ({
  // 岗位匹配语义（2026-09-07 岗位即分类）：role 即岗位名，acquire 按岗位精确命中；skills 保留为退役字段随意值
  id, name: id, roles: ['backend'], skills: ['backend'], capabilities, enabled, createdAt: 1,
});

describe('ManagedRoster（员工档案支撑调度，2026-09-06）', () => {
  let store: FileEmployeeStore;
  let roster: ManagedRoster;
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mroster-'));
    store = new FileEmployeeStore(join(dir, 'e.json'));
    await store.upsert(rec('emp-a', ['dev', 'commit']));
    await store.upsert(rec('emp-b', ['dev']));
    await store.upsert(rec('emp-c', [], false)); // 停用
    roster = new ManagedRoster(store);
    await roster.refresh();
  });

  it('refresh 后 acquire：停用员工不可分派；release 归还', () => {
    const e = roster.acquire('backend');
    expect(e?.id).toBe('emp-a');
    expect(roster.acquire('backend')?.id).toBe('emp-b'); // 顺位取第二个（emp-c 停用不在池）
    expect(roster.acquire('backend')).toBeNull(); // 空闲耗尽：停用者也不可被分派
    roster.release(e!.id);
    expect(roster.acquire('backend')?.id).toBe('emp-a');
  });

  it('岗位匹配为 role 精确相等（skills 退役）：skills 含岗位名但 role 不同 → 不命中', async () => {
    // 共享夹具 emp-a/emp-b 岗位即 'backend' 且空闲，先取空（refresh 保持占用）以隔离验证：
    // emp-x skills 含 'backend' 但 role 不同 → 不得命中（skills 集合匹配退役）
    expect(roster.acquire('backend')?.id).toBe('emp-a');
    expect(roster.acquire('backend')?.id).toBe('emp-b');
    await store.upsert({ id: 'emp-x', name: '错岗', roles: ['前端开发'], skills: ['backend'], capabilities: [], enabled: true, createdAt: 1 });
    await roster.refresh();
    expect(roster.acquire('backend')).toBeNull();
  });

  it('多岗位：pkg.role 命中员工任一岗位即可分派；不在集合不命中', async () => {
    await store.upsert({ id: 'emp-full', name: '全栈', roles: ['后端开发', '前端开发'], skills: [], capabilities: [], enabled: true, createdAt: 1 } as EmployeeRecord);
    await roster.refresh();
    // 夹具 acquire 后不自动 release：用例内自行释放后再取第二岗
    expect(roster.acquire('后端开发')?.id).toBe('emp-full');
    roster.release('emp-full');
    expect(roster.acquire('前端开发')?.id).toBe('emp-full');
    roster.release('emp-full');
    expect(roster.acquire('测试')).toBeNull();
  });

  it('canDispatch 谓词：plan 任务项 kind ∈ 员工 capabilities（空=全部可用）', () => {
    const planTask = { pkg: { taskId: 't', plan: [{ id: 'x', kind: 'commit', title: 'x', detail: 'd' }] }, status: 'pending' } as unknown as TaskRecord;
    expect(roster.canDispatch(planTask, { id: 'emp-a' } as never)).toBe(true);
    expect(roster.canDispatch(planTask, { id: 'emp-b' } as never)).toBe(false);
    const devTask = { pkg: { taskId: 't2', plan: [{ id: 'y', title: 'y', detail: 'd' }] }, status: 'pending' } as unknown as TaskRecord;
    expect(roster.canDispatch(devTask, { id: 'emp-b' } as never)).toBe(true); // 缺省 dev
    const oldTask = { pkg: { taskId: 't3' }, status: 'pending' } as unknown as TaskRecord;
    expect(roster.canDispatch(oldTask, { id: 'emp-b' } as never)).toBe(true); // 无 plan 不限
  });

  it('refresh 保持占用：已分派未释放的员工不会被二次分派（员工级串行化）', async () => {
    const e = roster.acquire('backend');
    expect(e?.id).toBe('emp-a');
    await roster.refresh(); // 档案未变：占用必须跨 refresh 保持
    expect(roster.acquire('backend')?.id).toBe('emp-b'); // emp-a 在运行中，不可再取
    expect(roster.acquire('backend')).toBeNull(); // 其余空闲耗尽，emp-a 也不可被取
    roster.release(e!.id);
    expect(roster.acquire('backend')?.id).toBe('emp-a'); // release 后归还
  });

  it('refresh 后停用生效：停用优先于占用保持（消失/停用的占用条目自然丢弃）', async () => {
    const e = roster.acquire('backend');
    expect(e?.id).toBe('emp-a');
    await store.setEnabled('emp-a', false); // 后台停用在运行中的员工
    await roster.refresh();
    expect(roster.acquire('backend')?.id).toBe('emp-b'); // emp-a 已停用，不再进池
    expect(roster.acquire('backend')).toBeNull();
    roster.release('emp-a'); // 停用者的 release 应为 no-op（不回池）
    expect(roster.acquire('backend')).toBeNull();
  });

  it('refresh 后新启用员工进池：全部占用时后台新增员工可被 acquire', async () => {
    const e1 = roster.acquire('backend');
    const e2 = roster.acquire('backend');
    expect([e1?.id, e2?.id]).toEqual(['emp-a', 'emp-b']);
    expect(roster.acquire('backend')).toBeNull(); // 空闲耗尽
    await store.upsert(rec('emp-d', [])); // 后台新增员工（空 capabilities = 全部可用）
    await roster.refresh();
    expect(roster.acquire('backend')?.id).toBe('emp-d'); // 新档案生效，且旧占用仍保持
    expect(roster.acquire('backend')).toBeNull(); // emp-a/emp-b 占用未丢
  });

  it('acquireById：点名空闲员工占用；忙/未知/停用返回 null；isKnown 区分存在与停用', () => {
    expect(roster.isKnown('emp-a')).toBe(true);
    const got = roster.acquireById('emp-a');
    expect(got?.id).toBe('emp-a');
    expect(roster.acquireById('emp-a')).toBeNull(); // 已占用 → null
    expect(roster.isKnown('emp-a')).toBe(true);     // 占用 ≠ 不存在
    roster.release('emp-a');
    expect(roster.acquireById('emp-a')?.id).toBe('emp-a');
    expect(roster.isKnown('ghost')).toBe(false);    // 不存在
    expect(roster.acquireById('ghost')).toBeNull();
    expect(roster.isKnown('emp-c')).toBe(false);    // 停用不在 refresh 快照 → 不可用
  });

  it('capabilitiesOf：档案查询（store 直查，供装配层做同步谓词）', () => {
    expect(roster.capabilitiesOf('emp-a')).toEqual(['dev', 'commit']);
    expect(roster.capabilitiesOf('nobody')).toBeUndefined();
  });

  it('modelOf：员工专属模型转 ModelSpec（未绑定 undefined；密文解密/明文存量透传，2026-09-11 复盘批）', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'mroster2-'));
    const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
    try {
      const { encryptSecret } = await import('../src/team/credentials.js');
      const s = new FileEmployeeStore(join(dir2, 'e.json'));
      await s.upsert({ ...rec('emp-x', ['dev']), model: { baseUrl: 'http://x/v1', apiKey: encryptSecret('sk-real', KEY), model: 'glm-x', api: 'anthropic-messages' } });
      await s.upsert({ ...rec('emp-p', ['dev']), model: { baseUrl: 'http://x/v1', apiKey: 'sk-plain-legacy', model: 'glm-p' } });
      const r2 = new ManagedRoster(s);
      await r2.refresh();
      vi.stubEnv('DDW_CRED_KEY', KEY);
      try {
        expect(r2.modelOf('emp-x')).toEqual({
          name: 'emp-x-glm-x', baseUrl: 'http://x/v1', apiKey: 'sk-real', model: 'glm-x', api: 'anthropic-messages',
        });
        expect(r2.modelOf('emp-p')!.apiKey).toBe('sk-plain-legacy'); // 明文存量透传（无主密钥环境零回归）
      } finally {
        vi.unstubAllEnvs();
      }
      // 密文且缺主密钥 = 可读错误（不带病执行，模型集群 401 远难排查）
      expect(() => r2.modelOf('emp-x')).toThrow(/DDW_CRED_KEY/);
      expect(r2.modelOf('emp-a')).toBeUndefined(); // 未绑定模型
    } finally { await rm(dir2, { recursive: true, force: true }); }
  });
});
