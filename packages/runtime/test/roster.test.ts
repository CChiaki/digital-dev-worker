import { describe, it, expect } from 'vitest';
import { EmployeeRoster, type EmployeeProfile } from '../src/team/roster.js';

/**
 * 遗留收尾 T2（2026-09-08）：acquire 匹配语义对齐 ManagedRoster —— 按员工主岗 role 精确匹配，
 * skills 集合匹配退役。夹具刻意让 role 与 skills 分叉（role=backend，skills 额外含 fullstack），
 * 用于锁死「skills 不再参与分派匹配」的语义变化。
 */
const emp = (id: string, role: string, skills: string[] = [role]): EmployeeProfile => ({
  id, name: `员工${id}`, role, skills,
});

describe('EmployeeRoster（班组名册：岗位匹配 + 空闲管理）', () => {
  const roster = () => new EmployeeRoster([
    emp('emp-01', 'frontend'),
    emp('emp-02', 'backend'),
    emp('emp-03', 'test'),
  ]);

  it('按任务包岗位精确匹配员工主岗 role', () => {
    const r = roster();
    expect(r.acquire('backend')?.id).toBe('emp-02');
    expect(r.acquire('test')?.id).toBe('emp-03');
  });

  it('语义变化留痕（2026-09-08）：skills 不再参与匹配——岗位不在主岗则不命中（旧 skills 集合匹配下可命中）', () => {
    const r = new EmployeeRoster([emp('emp-01', 'backend', ['backend', 'fullstack'])]);
    expect(r.acquire('fullstack')).toBeNull(); // 旧语义按 skills 集合会命中，现役 role 精确匹配不命中
    expect(r.acquire('backend')?.id).toBe('emp-01');
  });

  it('无 role 的任务包任意空闲员工可接', () => {
    const r = roster();
    expect(r.acquire()?.id).toBe('emp-01');
  });

  it('无匹配岗位（或全忙）返回 null', () => {
    expect(roster().acquire('dba')).toBeNull();
    const r = roster();
    r.acquire('frontend');
    r.acquire('backend');
    r.acquire('test');
    expect(r.acquire('frontend')).toBeNull(); // frontend 唯一员工已忙
  });

  it('acquire 即占用：同一员工不会被分派两个任务', () => {
    const r = roster();
    expect(r.acquire('frontend')?.id).toBe('emp-01');
    expect(r.acquire('frontend')).toBeNull(); // emp-01 已占用，无他人主岗为 frontend
    expect(r.freeIds()).toEqual(['emp-02', 'emp-03']);
  });

  it('release 归还后可再次被分派', () => {
    const r = roster();
    const e1 = r.acquire('frontend');
    r.release(e1!.id);
    expect(r.acquire('frontend')?.id).toBe('emp-01');
  });

  it('acquire 支持可选谓词 extra：不满足者跳过（零回归：不传谓词行为不变）', () => {
    const r = new EmployeeRoster([
      emp('a', 'backend'),
      emp('b', 'backend'),
    ]);
    expect(r.acquire('backend', (p) => p.id === 'b')?.id).toBe('b');
    expect(r.acquire('backend', () => false)).toBeNull();
    expect(r.acquire('backend')?.id).toBe('a'); // 不传谓词零回归
  });

  it('acquireById 点名分派（2026-09-06 assignee）：空闲即占用；忙/未知返回 null；isKnown 只看存在性', () => {
    const r = roster();
    expect(r.isKnown('emp-01')).toBe(true);
    const got = r.acquireById('emp-01');
    expect(got?.id).toBe('emp-01');
    expect(r.acquireById('emp-01')).toBeNull(); // 已占用 → null
    expect(r.isKnown('emp-01')).toBe(true);     // 占用 ≠ 不存在
    r.release('emp-01');
    expect(r.acquireById('emp-01')?.id).toBe('emp-01');
    expect(r.isKnown('ghost')).toBe(false);     // 不存在
    expect(r.acquireById('ghost')).toBeNull();
  });

  it('release 不存在的员工抛错', () => {
    expect(() => roster().release('emp-x')).toThrow('员工不存在');
  });

  it('名册 id 重复抛错（配置错误早暴露）', () => {
    expect(() => new EmployeeRoster([emp('emp-01', 'a'), emp('emp-01', 'b')])).toThrow('重复');
  });
});
