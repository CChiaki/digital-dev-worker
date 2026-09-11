import type { SupervisionPolicy } from '../types.js';

/** 数字员工档案：班组名册的最小单元（试点期配置化，不进数据库） */
export interface EmployeeProfile {
  id: string;
  name: string;
  /** 主岗位（展示用；2026-09-08 起兼作分派匹配字段——role 精确匹配，见 acquire） */
  role: string;
  /** 可接任务岗位集合（遗留收尾 T2 2026-09-08 退役：仅保留字段兼容 yaml 配置，不再参与分派匹配） */
  skills: string[];
  /** 盯梢放权策略（spec 4.4），缺省 shadow */
  supervision?: SupervisionPolicy;
}

/**
 * 员工名册（P8 班组并行）：岗位匹配 + 空闲管理。
 * acquire 即占用（同一员工不会被分派两个任务），执行完 release 归还。
 */
export class EmployeeRoster {
  private readonly free: Set<string>;

  constructor(private readonly profiles: EmployeeProfile[]) {
    const ids = new Set(profiles.map((p) => p.id));
    if (ids.size !== profiles.length) throw new Error('员工名册存在重复 id');
    this.free = new Set(ids);
  }

  all(): EmployeeProfile[] {
    return [...this.profiles];
  }

  get(id: string): EmployeeProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  freeIds(): string[] {
    return [...this.free];
  }

  /**
   * 从空闲员工中取一个可接该岗位的人（顺序取第一个）：
   * 任务包无 role → 任意空闲员工；有 role → 员工主岗精确等值（p.role === role）。
   * 语义变化留痕（遗留收尾 T2 2026-09-08）：旧实现按 skills 集合匹配（role ∈ p.skills），
   * 与岗位管理两轮改造后的 ManagedRoster（员工档案 roles，装配层事实源）分叉；
   * 现对齐为 role 精确匹配（等价 ManagedRoster 单岗行为），yaml 回退路径下
   * 「role 之外、skills 之中」的岗位不再命中——yaml profiles 请保证主岗与任务包岗位一致。
   * extra 可选谓词（2026-09-06 分派过滤钩子）：返回 false 的员工跳过（如能力绑定过滤）；
   * 不传谓词行为零回归。取到即占用；无匹配返回 null（调度器据此保持任务在池中）。
   */
  acquire(role?: string, extra?: (p: EmployeeProfile) => boolean): EmployeeProfile | null {
    const hit = this.profiles.find(
      (p) => this.free.has(p.id) && (!role || p.role === role) && (!extra || extra(p)),
    );
    if (!hit) return null;
    this.free.delete(hit.id);
    return hit;
  }

  /** 点名分派（2026-09-06 assignee）：空闲时占用返回；忙/不存在 → null（忽略岗位匹配） */
  acquireById(id: string): EmployeeProfile | null {
    if (!this.free.has(id)) return null;
    const hit = this.get(id);
    if (!hit) return null;
    this.free.delete(id);
    return hit;
  }

  /** 员工是否存在（不含占用状态，2026-09-06 assignee）：供调度器区分「忙」与「不可用」 */
  isKnown(id: string): boolean {
    return this.get(id) !== undefined;
  }

  /** 归还员工（任务执行结束/失败后调用） */
  release(id: string): void {
    if (!this.get(id)) throw new Error(`员工不存在: ${id}`);
    this.free.add(id);
  }
}
