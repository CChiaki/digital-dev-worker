import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSkillStore, newSkillId, validateSkillRecord, validateSkillCategory,
  type SkillRecord,
} from '../src/team/skill-store.js';

let dir: string;
let store: FileSkillStore;

const rec = (over: Partial<SkillRecord> = {}): SkillRecord => ({
  id: newSkillId(), categoryId: 'backend', name: '接口异常码规范', description: 'REST 异常码约定',
  type: 'knowledge', content: '所有接口异常码以 E 开头…', status: 'pending', source: 'manual', createdAt: Date.now(),
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skills-'));
  store = new FileSkillStore(join(dir, 'skills.json'));
});

describe('FileSkillStore 分类', () => {
  it('ensureSeed：空目录初始化内置五类并落盘', async () => {
    await store.ensureSeed();
    const cats = await store.listCategories();
    expect(cats.map((c) => c.id)).toEqual(['backend', 'frontend', 'testing', 'devops', 'security']);
    // 落盘校验：文件确实写出来了
    const raw = JSON.parse(await readFile(join(dir, 'skills.json'), 'utf8'));
    expect(raw.categories.length).toBe(5);
    expect(raw.skills).toEqual([]);
  });

  it('ensureSeed 幂等：已有文件不覆盖', async () => {
    await store.upsertCategory({ id: 'custom', name: '自定义' });
    await store.ensureSeed();
    const cats = await store.listCategories();
    expect(cats.map((c) => c.id)).toContain('custom');
    expect(cats.map((c) => c.id)).not.toContain('backend'); // 未被 seed 覆盖
  });

  it('upsertCategory：新增与更新', async () => {
    await store.ensureSeed();
    await store.upsertCategory({ id: 'backend', name: '后端开发（改）' });
    const cats = await store.listCategories();
    expect(cats.find((c) => c.id === 'backend')?.name).toBe('后端开发（改）');
    expect(cats.length).toBe(5);
  });

  it('deleteCategory：挂载保护 / 不存在 / 正常删除', async () => {
    await store.ensureSeed();
    await store.upsertSkill(rec());
    expect(await store.deleteCategory('backend')).toBe('mounted');
    expect(await store.deleteCategory('nope')).toBe('missing');
    await store.upsertCategory({ id: 'tmp', name: '临时' });
    expect(await store.deleteCategory('tmp')).toBe('deleted');
  });

  it('upsertCategory name 唯一（岗位业务键）：同名且非自身 → name-conflict 不落盘', async () => {
    const store = new FileSkillStore(join(dir, 'skills.json'));
    await store.upsertCategory({ id: 'a', name: '后端开发' });
    await store.upsertCategory({ id: 'b', name: '前端开发' });
    // 同名不同 id → 冲突
    const r1 = await store.upsertCategory({ id: 'c', name: '后端开发' });
    expect(r1).toBe('name-conflict');
    expect((await store.listCategories()).map((c) => c.id)).toEqual(['a', 'b']);
    // 同 id 更新自身 name → 放行
    const r2 = await store.upsertCategory({ id: 'a', name: '后端研发' });
    expect(r2).toBe('upserted');
    // 同名同 id（幂等重复提交）→ 放行
    const r3 = await store.upsertCategory({ id: 'a', name: '后端研发' });
    expect(r3).toBe('upserted');
  });
});

describe('FileSkillStore skill CRUD 与审查', () => {
  beforeEach(() => store.ensureSeed());

  it('upsertSkill + listSkills 过滤（status/categoryId）', async () => {
    const a = rec({ status: 'approved', reviewedAt: Date.now() });
    const b = rec({ categoryId: 'frontend' });
    await store.upsertSkill(a);
    await store.upsertSkill(b);
    expect((await store.listSkills()).length).toBe(2);
    expect((await store.listSkills({ status: 'pending' })).map((s) => s.id)).toEqual([b.id]);
    expect((await store.listSkills({ categoryId: 'backend' })).map((s) => s.id)).toEqual([a.id]);
  });

  it('reviewSkill：approve / reject / 改判 / 不存在', async () => {
    const s = rec();
    await store.upsertSkill(s);
    expect((await store.reviewSkill(s.id, 'approve'))?.status).toBe('approved');
    expect((await store.reviewSkill(s.id, 'reject'))?.status).toBe('rejected'); // 允许改判
    expect((await store.reviewSkill(s.id, 'reject'))?.reviewedAt).toBeGreaterThan(0);
    expect(await store.reviewSkill('nope', 'approve')).toBeNull();
  });

  it('removeSkill：存在 true / 不存在 false', async () => {
    const s = rec();
    await store.upsertSkill(s);
    expect(await store.removeSkill(s.id)).toBe(true);
    expect(await store.removeSkill(s.id)).toBe(false);
  });

  it('skillsForCategories：仅返回 approved 且命中分类', async () => {
    await store.upsertSkill(rec({ status: 'approved' }));
    await store.upsertSkill(rec()); // pending 不算
    await store.upsertSkill(rec({ categoryId: 'frontend', status: 'approved' }));
    const got = await store.skillsForCategories(['backend']);
    expect(got.length).toBe(1);
    expect(got[0]!.status).toBe('approved');
  });

  it('原子写与重载：新实例读到同一数据', async () => {
    const s = rec();
    await store.upsertSkill(s);
    const again = new FileSkillStore(join(dir, 'skills.json'));
    expect((await again.getSkill(s.id))?.name).toBe(s.name);
  });
});

describe('校验函数', () => {
  it('validateSkillRecord：type 枚举 / categoryId 必须注册 / asset 必须带文件 / 路径逃逸', () => {
    const ids = ['backend'];
    expect(() => validateSkillRecord(rec(), ids)).not.toThrow();
    expect(() => validateSkillRecord(rec({ type: 'hack' as never }), ids)).toThrow('type');
    expect(() => validateSkillRecord(rec({ categoryId: 'nope' }), ids)).toThrow('categoryId');
    expect(() => validateSkillRecord(rec({ type: 'asset' }), ids)).toThrow('assetFiles');
    expect(() => validateSkillRecord(rec({ type: 'asset', assetFiles: [{ path: '../evil.sh', content: 'x' }] }), ids)).toThrow('..');
    expect(() => validateSkillRecord(rec({ type: 'asset', assetFiles: [{ path: '/etc/passwd', content: 'x' }] }), ids)).toThrow('绝对路径');
    expect(() => validateSkillRecord(rec({ type: 'asset', assetFiles: [{ path: '', content: 'x' }] }), ids)).toThrow('不能为空');
    expect(() => validateSkillRecord(rec({ type: 'asset', assetFiles: [{ path: 'scripts/check.sh', content: 'x' }] }), ids)).not.toThrow();
    expect(() => validateSkillRecord(rec({ name: ' ' }), ids)).toThrow('name');
    expect(() => validateSkillRecord(rec({ content: '' }), ids)).toThrow('content');
  });

  it('store 层形状/路径校验下沉（终审 I1）：upsertSkill 绕过 HTTP 直调也拦截坏记录', async () => {
    await store.ensureSeed();
    // asset 无 assetFiles
    await expect(store.upsertSkill(rec({ type: 'asset' }))).rejects.toThrow('assetFiles');
    // assetFiles 路径逃逸（distiller 直调 upsertSkill 的攻击面）
    await expect(
      store.upsertSkill(rec({ type: 'asset', assetFiles: [{ path: '../evil.sh', content: 'x' }] })),
    ).rejects.toThrow('..');
    await expect(
      store.upsertSkill(rec({ type: 'asset', assetFiles: [{ path: '/etc/passwd', content: 'x' }] })),
    ).rejects.toThrow('绝对路径');
    // name/content 非空、type 枚举（不依赖分类表，进 store 层）
    await expect(store.upsertSkill(rec({ name: ' ' }))).rejects.toThrow('name');
    await expect(store.upsertSkill(rec({ content: '' }))).rejects.toThrow('content');
    await expect(store.upsertSkill(rec({ type: 'hack' as never }))).rejects.toThrow('type');
    // 坏记录不得落盘
    expect(await store.listSkills()).toHaveLength(0);
  });

  it('validateSkillCategory：id/name 非空', () => {
    expect(() => validateSkillCategory({ id: 'x', name: '测试分类' })).not.toThrow();
    expect(() => validateSkillCategory({ id: '', name: 'x' })).toThrow('id');
    expect(() => validateSkillCategory({ id: 'x', name: '' })).toThrow('name');
  });
});
