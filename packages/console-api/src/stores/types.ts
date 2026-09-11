import type { AgentEvent, EmployeeOutcome, PlanProgress, TaskPackage } from '@ddw/runtime';
import type { IntegrityReport } from './hash-chain.js';

/** 任务状态机（2026-09-06 起增加 draft：创建后默认草稿，发布才可被接取/分派）：
 *  draft → pending → claimed → running → done | failed */
export type TaskStatus = 'draft' | 'pending' | 'claimed' | 'running' | 'done' | 'failed';

export interface TaskRecord {
  pkg: TaskPackage;
  status: TaskStatus;
  claimedBy?: string;
  claimedAt?: number;
  /** 入池时间（2026-09-11 P1 治理批）：分派序改时间序（ORDER BY created_at ASC, id ASC）——
   *  旧库迁移行以 updated_at 近似回填（缺省 0 排最前 = 旧任务确实更早） */
  createdAt?: number;
  result?: EmployeeOutcome;
  /** 计划模式：逐项进度（续跑时 done 项不重做） */
  planProgress?: PlanProgress[];
  /** failed 时停在哪一项 */
  failedItemId?: string;
}

/**
 * 任务池存储接口（spec 5.2 存储中间层）：业务端只依赖此接口，
 * 实现（File/Sqlite/MySql）可替换，选择 = 组装处注入一行。
 */
export interface TaskStore {
  /** 固化任务包；opts.draft=true 初始为 draft（2026-09-06 发布态），缺省 pending（既有调用零变化） */
  add(pkg: TaskPackage, opts?: { draft?: boolean }): Promise<TaskRecord>;
  /** 发布（2026-09-06）：仅 draft → pending；其余状态抛错（HTTP 层 409） */
  publish(taskId: string): Promise<TaskRecord>;
  /** 指定/取消指定员工（2026-09-06 分派分离）：仅 draft/pending 可操作；employeeId 传 null = 取消指定。
   *  写 pkg.assignee；其余状态抛错（HTTP 层 409） */
  assign(taskId: string, employeeId: string | null): Promise<TaskRecord>;
  get(taskId: string): Promise<TaskRecord | null>;
  list(): Promise<TaskRecord[]>;
  /** 接单：pending → claimed；非 pending 抛错（HTTP 层映射 409） */
  claim(taskId: string, employeeId: string): Promise<TaskRecord>;
  /** 标记执行中（接单后、执行前） */
  markRunning(taskId: string): Promise<TaskRecord>;
  /** 回写执行结果（runtime 执行方调用）；计划模式附逐项进度与停点 */
  finish(taskId: string, outcome: EmployeeOutcome, ok: boolean, progress?: PlanProgress[], failedItemId?: string): Promise<TaskRecord>;
  /** 计划续跑：仅 failed 可续（→pending，保留 progress，清停点）；其余状态抛错（HTTP 层 409） */
  resumePlan(taskId: string): Promise<TaskRecord>;
  /** 强制重置（2026-09-11 P0 韧性批）：非 draft 任意状态 → pending，清空全部执行态
   *  （claimedBy/claimedAt/result/planProgress/failedItemId）；draft 抛错（用 publish）。
   *  崩溃恢复死锁兜底：running 态既不能重提也不能续跑时的管理员出路 */
  resetToPending(taskId: string): Promise<TaskRecord>;
}

export interface EventFilter {
  taskId?: string;
  employeeId?: string;
  type?: string;
  /** 只返回 ts >= since 的事件（轮询增量拉取，at-least-once） */
  since?: number;
}

/**
 * 事件流存储接口（直播/审计同源数据）。
 * append 必须保序（同一事件流内与写入顺序一致）；list 按 ts 升序。
 * 支持审计 hash 链的实现额外提供 verifyIntegrity（spec 5.2，篡改可检测）
 * 与 snapshotHead（链头快照归档：独立文件存证，篡改者改库也重算不出一致快照）。
 */
export interface EventStore {
  append(event: AgentEvent): Promise<void>;
  list(filter?: EventFilter): Promise<AgentEvent[]>;
  /** 审计 hash 链完整性校验（prev_hash + SHA-256 成链 + 快照比对）；不支持链的实现可不提供 */
  verifyIntegrity?(): Promise<IntegrityReport>;
  /** 链头快照归档：把当前末条事件 (id, hash) 追加写入独立快照文件 */
  snapshotHead?(): Promise<{ id: string; hash: string }>;
}
