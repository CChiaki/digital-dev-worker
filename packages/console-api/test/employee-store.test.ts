import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileEmployeeStore, normalizeEmployeeInput, validateEmployeeRecord, encryptEmployeeModelKey } from '../src/team/employee-store.js';
import type { EmployeeRecord } from '../src/team/employee-store.js';

const rec = () => ({
  id: 'emp-01', name: '张三', roles: ['后端开发'], skills: ['backend'],
  capabilities: ['dev', 'commit'], enabled: true, createdAt: 1_700_000_000_000,
});

describe('FileEmployeeStore（员工档案后台化，2026-09-06）', () => {
  it('upsert 新增/修改；list/get/setEnabled（停用不物理删）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emp-'));
    try {
      const store = new FileEmployeeStore(join(dir, 'employees.json'));
      await store.upsert(rec());
      expect((await store.list()).map((e) => e.id)).toEqual(['emp-01']);
      await store.upsert({ ...rec(), name: '张三丰' });
      expect((await store.get('emp-01'))?.name).toBe('张三丰');
      const disabled = await store.setEnabled('emp-01', false);
      expect(disabled?.enabled).toBe(false);
      expect(await store.get('emp-01')).toBeDefined(); // 停用≠删除
      expect(await store.setEnabled('nope', false)).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('seedFrom：yaml profiles 导入（capabilities 空=全部可用）；文件已存在时不覆盖', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emp-'));
    try {
      const store = new FileEmployeeStore(join(dir, 'employees.json'));
      await store.seedFrom([{ id: 'emp-01', name: '张三', role: '后端', skills: ['backend'] }]);
      const first = await store.get('emp-01');
      expect(first?.capabilities).toEqual([]);
      expect(first?.enabled).toBe(true);
      // 落盘 JSON 不带退役字段（2026-09-08 遗留收尾 T3）：种子档案新落盘必须干净
      const raw = readFileSync(join(dir, 'employees.json'), 'utf8');
      expect(raw).not.toContain('"skillCategories"');
      expect(raw).not.toContain('"skills"');
      await store.upsert({ ...rec(), name: '后台改名' });
      await store.seedFrom([{ id: 'emp-02', name: '李四', role: '测试', skills: ['test'] }]);
      expect((await store.get('emp-01'))?.name).toBe('后台改名'); // 二次 seed 不覆盖
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('validateEmployeeRecord：id/name 非空、capabilities 字符串数组、capabilities 白名单校验、supervision.level 合法值', () => {
    expect(() => validateEmployeeRecord(rec(), ['dev', 'commit'])).not.toThrow();
    expect(() => validateEmployeeRecord({ ...rec(), id: '' }, [])).toThrow(/id 必须是非空字符串/);
    expect(() => validateEmployeeRecord({ ...rec(), capabilities: ['nope'] }, ['dev'])).toThrow(/capabilities 含未注册的能力/);
    expect(() => validateEmployeeRecord({ ...rec(), supervision: { level: 'bogus' as never } }, [])).toThrow(/supervision\.level/);
  });

  it('validateEmployeeRecord：model 绑定校验（baseUrl/model/apiKey 必填、api 枚举；缺省不绑定零回归）', () => {
    expect(() => validateEmployeeRecord({ ...rec(), model: { baseUrl: 'http://m/v1', apiKey: 'k', model: 'glm-x' } }, [])).not.toThrow();
    expect(() => validateEmployeeRecord({ ...rec(), model: { baseUrl: 'http://m/v1', apiKey: 'k', model: 'glm-x', api: 'anthropic-messages' } }, [])).not.toThrow();
    expect(() => validateEmployeeRecord({ ...rec(), model: { baseUrl: '', apiKey: 'k', model: 'glm-x' } }, [])).toThrow(/model\.baseUrl 必须是非空字符串/);
    expect(() => validateEmployeeRecord({ ...rec(), model: { baseUrl: 'http://m/v1', apiKey: '', model: 'glm-x' } }, [])).toThrow(/model\.apiKey 必须是非空字符串/);
    expect(() => validateEmployeeRecord({ ...rec(), model: { baseUrl: 'http://m/v1', apiKey: 'k', model: '' } }, [])).toThrow(/model\.model 必须是非空字符串/);
    expect(() => validateEmployeeRecord({ ...rec(), model: { baseUrl: 'http://m/v1', apiKey: 'k', model: 'glm-x', api: 'bogus' as never } }, [])).toThrow(/model\.api 必须是/);
  });
});

describe('EmployeeRecord.skillCategories（2026-09-06 Skill 关联）', () => {
  const base = { id: 'emp-9', name: '小测', roles: ['backend'], skills: ['backend'], capabilities: [], enabled: true };

  it('seedFrom：退役 skillCategories 不再落盘（2026-09-08 遗留收尾 T3，原「置空数组」语义随字段退役撤销）', async () => {
    const { FileEmployeeStore } = await import('../src/team/employee-store.js');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'emp-'));
    const store = new FileEmployeeStore(join(dir, 'employees.json'));
    await store.seedFrom([{ id: 'p1', name: '甲', role: 'backend', skills: ['backend'] } as never]);
    const got = await store.get('p1');
    expect(got?.skillCategories).toBeUndefined();
  });
});

describe('岗位即分类（2026-09-07）：roles 严格校验', () => {
  const base = { id: 'e1', name: '小数', roles: ['后端开发'], skills: [], capabilities: [], enabled: true, createdAt: 1 };

  it('roles 含未注册岗位 → 400 文案列出可选岗位', () => {
    expect(() => validateEmployeeRecord({ ...base, roles: ['backend'] } as EmployeeRecord, [], ['后端开发', '前端开发']))
      .toThrow(/roles 含未注册岗位.*backend.*后端开发 \/ 前端开发/);
  });

  it('roles 全部在清单 → 通过；skills/skillCategories 旧字段忽略不报错（任意形状）', () => {
    expect(() => validateEmployeeRecord({ ...base, skills: ['whatever'] } as EmployeeRecord, [], ['后端开发'])).not.toThrow();
    expect(() => validateEmployeeRecord({ ...base, skillCategories: 'not-an-array' } as unknown as EmployeeRecord, [], ['后端开发'])).not.toThrow();
  });

  it('岗位清单为空（未装配 Skill 库）→ roles 仅做非空校验，不设限', () => {
    expect(() => validateEmployeeRecord({ ...base, roles: ['自由岗位'] } as EmployeeRecord, [], [])).not.toThrow();
  });
});

describe('员工多岗位（2026-09-07）', () => {
  it('normalizeEmployeeInput：旧单值 role 包装为 roles；roles 原样透传', () => {
    const legacy = normalizeEmployeeInput({ id: 'e1', name: '小数', role: '后端开发', capabilities: [], enabled: true } as unknown as EmployeeRecord);
    expect(legacy.roles).toEqual(['后端开发']);
    const multi = normalizeEmployeeInput({ id: 'e2', name: '小智', roles: ['后端开发', '前端开发'], capabilities: [], enabled: true } as unknown as EmployeeRecord);
    expect(multi.roles).toEqual(['后端开发', '前端开发']);
  });

  it('FileEmployeeStore 读旧格式文件：单值 role 自动归一为 roles，skills/skillCategories 兼容忽略', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emp-'));
    try {
      const file = join(dir, `employees-legacy-${Date.now()}.json`);
      await writeFile(file, JSON.stringify([
        { id: 'old1', name: '旧档', role: 'backend', skills: ['backend'], skillCategories: ['x'], capabilities: [], enabled: true, createdAt: 1 },
      ]), 'utf8');
      const store = new FileEmployeeStore(file);
      const rec = (await store.list())[0];
      expect(rec.roles).toEqual(['backend']);
      expect((rec as unknown as { role?: string }).role).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('validateEmployeeRecord：roles 为空 → 400；含未注册岗位 → 400 列清单；白名单空不设限', () => {
    const base = { id: 'e1', name: '小数', roles: ['后端开发'], capabilities: [], enabled: true };
    expect(() => validateEmployeeRecord({ ...base, roles: [] } as unknown as EmployeeRecord, [], ['后端开发']))
      .toThrow(/至少挂载一个岗位/);
    expect(() => validateEmployeeRecord({ ...base, roles: ['后端开发', '不存在的岗'] } as unknown as EmployeeRecord, [], ['后端开发', '前端开发']))
      .toThrow(/roles 含未注册岗位.*不存在的岗.*必须是已注册岗位: 后端开发 \/ 前端开发/);
    expect(() => validateEmployeeRecord({ ...base } as unknown as EmployeeRecord, [], [])).not.toThrow();
  });
});

describe('员工档案卫生（2026-09-08 遗留收尾 T3）：roles trim 归一 + 脏档警告', () => {
  it('normalizeEmployeeInput：roles 逐项 trim，trim 后空项剔除', () => {
    const got = normalizeEmployeeInput({ id: 'e1', name: '小数', roles: ['  后端开发 ', '   ', '前端开发'], skills: [], capabilities: [], enabled: true, createdAt: 1 });
    expect(got.roles).toEqual(['后端开发', '前端开发']);
  });

  it('normalizeEmployeeInput：旧单值 role 带空白 → trim 后包装；纯空白 → 空数组（由校验拒绝）', () => {
    const legacy = normalizeEmployeeInput({ id: 'e1', name: '小数', role: ' 后端开发 ', capabilities: [], enabled: true } as unknown as EmployeeRecord);
    expect(legacy.roles).toEqual(['后端开发']);
    const blank = normalizeEmployeeInput({ id: 'e2', name: '小智', role: '   ', capabilities: [], enabled: true } as unknown as EmployeeRecord);
    expect(blank.roles).toEqual([]);
    expect(() => validateEmployeeRecord(blank, [], ['后端开发'])).toThrow(/至少挂载一个岗位/);
  });

  it('FileEmployeeStore 读脏档：roles 逐项 trim + 空项剔除；剔除后空数组 → console.warn 一次（中文，含 id/name），不抛错不阻断', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emp-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const file = join(dir, `employees-dirty-${Date.now()}.json`);
      await writeFile(file, JSON.stringify([
        { id: 'a1', name: '带空白', roles: [' 后端开发 ', '   ', '前端开发'], skills: [], capabilities: [], enabled: true, createdAt: 1 },
        { id: 'b2', name: '脏员工', roles: ['  ', ''], skills: [], capabilities: [], enabled: true, createdAt: 2 },
        { id: 'c3', name: '旧单值空白', role: ' backend ', skills: [], capabilities: [], enabled: true, createdAt: 3 },
      ]), 'utf8');
      const store = new FileEmployeeStore(file);
      const list = await store.list();
      expect(list.find((r) => r.id === 'a1')?.roles).toEqual(['后端开发', '前端开发']);
      expect(list.find((r) => r.id === 'b2')?.roles).toEqual([]); // 保留记录，不丢弃
      expect(list.find((r) => r.id === 'c3')?.roles).toEqual(['backend']);
      // 一次性警告：聚合一条、中文、含员工 id/name
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(msg).toContain('b2');
      expect(msg).toContain('脏员工');
      expect(msg).toMatch(/roles/);
      // 二次读走缓存不再告警（load 只归一一次）
      await store.list();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('encryptEmployeeModelKey（员工模型 apiKey 写侧加密，2026-09-11 复盘批）', () => {
  const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
  const withModel = (apiKey: string): EmployeeRecord =>
    ({ ...rec(), model: { baseUrl: 'http://x/v1', apiKey, model: 'glm-x' } });

  it('明文 → enc:v1: 密文（主密钥在场）', () => {
    const out = encryptEmployeeModelKey(withModel('sk-plain'), { DDW_CRED_KEY: KEY });
    expect(out.model!.apiKey).toMatch(/^enc:v1:/);
    expect(out.model!.apiKey).not.toContain('sk-plain');
    expect(out.model!.baseUrl).toBe('http://x/v1'); // 其余字段不动
  });

  it('已是密文幂等跳过（PUT 回写保留的原 key 不二次加密）', () => {
    const enc = encryptEmployeeModelKey(withModel('sk-plain'), { DDW_CRED_KEY: KEY }).model!.apiKey!;
    expect(encryptEmployeeModelKey(withModel(enc), { DDW_CRED_KEY: KEY }).model!.apiKey).toBe(enc);
  });

  it('无主密钥 / 未绑定模型 → 原样返回（零回归）', () => {
    expect(encryptEmployeeModelKey(withModel('sk-plain'), {}).model!.apiKey).toBe('sk-plain');
    const noModel = rec() as EmployeeRecord;
    expect(encryptEmployeeModelKey(noModel, { DDW_CRED_KEY: KEY })).toBe(noModel);
  });
});
