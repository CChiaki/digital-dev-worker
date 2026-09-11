import type { EmployeeProfile, ModelSpec } from '@ddw/runtime';
import type { EmployeeRecord, EmployeeStore } from './employee-store.js';
import type { TaskRecord } from '../stores/index.js';
import { resolveSecret } from './credentials.js';

/** 调度器名册最小接口（runtime EmployeeRoster 结构兼容；scheduler 依赖此类型便于注入） */
export type SchedulerRoster = {
  acquire(role?: string, extra?: (p: EmployeeProfile) => boolean): EmployeeProfile | null;
  /** 点名分派（2026-09-06 assignee）：空闲且启用时占用返回；忙/不存在/停用 → null */
  acquireById(id: string): EmployeeProfile | null;
  /** 员工存在且启用（不含占用状态）；与 acquireById 同快照，供调度留痕区分「忙」与「不可用」 */
  isKnown(id: string): boolean;
  release(id: string): void;
};

const kindsOf = (task: TaskRecord): string[] =>
  (task.pkg.plan ?? []).map((it) => it.kind ?? 'dev');

/**
 * 员工档案支撑的名册（2026-09-06 后台化）：EmployeeStore 为唯一事实源。
 * refresh() 由 pipeline 每 tick 前调用（后台改动下个 tick 生效，无需重启）；
 * canDispatch 是同步谓词（基于 refresh 时的档案快照），供 scheduler 分派前过滤
 * 「plan 任务项 kind ∈ 员工 capabilities（空=全部可用；无 plan 不限）」。
 */
export class ManagedRoster implements SchedulerRoster {
  private free = new Set<string>();
  private records: EmployeeRecord[] = [];

  constructor(private readonly store: EmployeeStore) {}

  async refresh(): Promise<void> {
    // 占用保持（2026-09-06 review 修复）：refresh 前已分派未释放者 = 旧全集 − free。
    // awaitCompletion=false 下长任务跨 tick 运行，占用必须跨 refresh 存续（员工级串行化），
    // 否则下个 tick 会给同一员工再分派第二个并发任务——回归旧 EmployeeRoster 的占用契约。
    const busy = new Set(this.records.map((r) => r.id).filter((id) => !this.free.has(id)));
    this.records = (await this.store.list()).filter((r) => r.enabled);
    this.free = new Set(this.records.map((r) => r.id));
    // 停用/删除的占用条目自然丢弃（release 对不存在者本就 no-op）；仍 enabled 的继续占用
    for (const id of busy) {
      if (this.records.some((r) => r.id === id)) this.free.delete(id);
    }
    // 注意：首次 refresh（构造后 records 尚空）语义 = 全部空闲，不触发占用保持
  }

  private recordOf(id: string): EmployeeRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** 同步能力谓词：无 plan 不限；plan 各项 kind（缺省 dev）都必须在员工绑定内（空=全部可用） */
  canDispatch(task: TaskRecord, employee: EmployeeProfile): boolean {
    const caps = this.capabilitiesOf(employee.id);
    if (caps === undefined) return true; // 不在档案（外部注入 profile，如测试）→ 不限制
    if (caps.length === 0) return true; // 空 = 全部可用
    const kinds = kindsOf(task);
    return kinds.every((k) => caps.includes(k));
  }

  private profileOf(r: EmployeeRecord): EmployeeProfile {
    return {
      // 多岗位（2026-09-07）：取主岗 roles[0] 填充 EmployeeProfile.role（runtime 单值，零改动）；分派匹配见 acquire
      id: r.id, name: r.name, role: r.roles[0] ?? '', skills: [...(r.skills ?? [])],
      ...(r.supervision ? { supervision: r.supervision } : {}),
    };
  }

  acquire(role?: string, extra?: (p: EmployeeProfile) => boolean): EmployeeProfile | null {
    const hit = this.records.find((r) => {
      if (!this.free.has(r.id)) return false;
      // 岗位精确匹配（2026-09-07 岗位即分类）：role 即岗位名，skills 集合匹配退役；
      // 多岗位（2026-09-07）：任务岗位命中员工任一岗位即可分派
      if (role && !r.roles.includes(role)) return false;
      if (extra && !extra(this.profileOf(r))) return false;
      return true;
    });
    if (!hit) return null;
    this.free.delete(hit.id);
    return this.profileOf(hit);
  }

  /** 点名分派（2026-09-06 assignee）：空闲且启用时占用返回；忙/不存在/停用 → null（忽略岗位匹配） */
  acquireById(id: string): EmployeeProfile | null {
    const hit = this.records.find((r) => r.id === id && this.free.has(r.id));
    if (!hit) return null;
    this.free.delete(hit.id);
    return this.profileOf(hit);
  }

  /** 员工存在且启用（不含占用状态）：与 acquireById 同一 refresh 快照 */
  isKnown(id: string): boolean {
    return this.records.some((r) => r.id === id);
  }

  release(id: string): void {
    if (this.records.some((r) => r.id === id)) this.free.add(id);
  }

  capabilitiesOf(id: string): string[] | undefined {
    return this.recordOf(id)?.capabilities;
  }

  /** 员工专属模型（装配 modelFor 用，2026-09-06 增补）：基于 refresh 快照同步访问；
   *  补齐 ModelSpec.name（员工专属命名，与 ModelSpec 同构）；未绑定返回 undefined。
   *  apiKey 用侧解密（2026-09-11 复盘批）：库里是 enc:v1: 密文（encryptEmployeeModelKey 写入）
   *  → 执行前解回明文传模型网关（密文只在内存外，不落日志不进任务快照）；
   *  密文且缺主密钥 = 可读错误（不带病执行，模型集群 401 远难排查）；明文存量原样透传 */
  modelOf(id: string): ModelSpec | undefined {
    const m = this.recordOf(id)?.model;
    if (!m) return undefined;
    return {
      name: `${id}-${m.model}`, baseUrl: m.baseUrl, apiKey: resolveSecret(m.apiKey), model: m.model,
      ...(m.api ? { api: m.api } : {}),
    };
  }
}
