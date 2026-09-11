import type { EmployeeOutcome, PlanProgress, TaskPackage } from '@ddw/runtime';
import type { TaskRecord, TaskStatus, TaskStore } from '../types.js';
import type { SqlDriver } from './driver.js';

export type { TaskStatus, TaskRecord } from '../types.js';

interface TaskRow {
  id: string;
  pkg: unknown;
  status: string;
  claimed_by: string | null;
  claimed_at: number | null;
  created_at: number | null;
  result: unknown;
  plan_progress: unknown;
  failed_item_id: string | null;
}

const COLS = 'id, pkg, status, claimed_by, claimed_at, created_at, result, plan_progress, failed_item_id';

/**
 * 任务池 SQL 实现（存储企业化 spec §4/§5）：基于 SqlDriver 方言抽象，
 * sqlite / mysql 共用同一份 DAO——表 ddw_tasks，JSON 列经 encodeJson/decodeJson，
 * affected 行数判定统一走 driver.run（sqlite changes / mysql affectedRows 由驱动收敛）。
 * claim/publish/resumePlan 用 UPDATE ... WHERE 状态限定的受影响行数保证原子性，
 * 天然支撑多员工并发抢单（语义与退役的 SqliteTaskStore 完全一致）。
 */
export class SqlTaskStore implements TaskStore {
  private driver: SqlDriver;

  constructor(driver: SqlDriver) {
    this.driver = driver;
  }

  private rowToRecord(row: TaskRow): TaskRecord {
    return {
      pkg: this.driver.decodeJson<TaskPackage>(row.pkg),
      status: row.status as TaskStatus,
      ...(row.claimed_by ? { claimedBy: row.claimed_by, claimedAt: row.claimed_at ?? undefined } : {}),
      ...(row.created_at ? { createdAt: row.created_at } : {}),
      ...(row.result ? { result: this.driver.decodeJson<EmployeeOutcome>(row.result) } : {}),
      ...(row.plan_progress ? { planProgress: this.driver.decodeJson<PlanProgress[]>(row.plan_progress) } : {}),
      ...(row.failed_item_id ? { failedItemId: row.failed_item_id } : {}),
    };
  }

  async add(pkg: TaskPackage, opts?: { draft?: boolean }): Promise<TaskRecord> {
    const status: TaskStatus = opts?.draft ? 'draft' : 'pending';
    // 重提交同 taskId：upsert 覆盖（方言差异收在驱动）；resetCols 清空执行态窄列——
    // 终态任务重提交重跑时不得串上一轮 claimedBy/result/进度/停点（T2 评审 P1，等价旧 INSERT OR REPLACE）；
    // created_at 同步刷新（2026-09-11）：重提交 = 回队列重新排队，分派序取新时间
    await this.driver.run(
      this.driver.upsertSql(
        'ddw_tasks',
        'id',
        ['pkg', 'status', 'created_at', 'updated_at'],
        ['claimed_by', 'claimed_at', 'result', 'plan_progress', 'failed_item_id'],
      ),
      [pkg.taskId, this.driver.encodeJson(pkg), status, Date.now(), Date.now()],
    );
    return { pkg, status, createdAt: Date.now() };
  }

  /** 发布（2026-09-06）：仅 draft → pending；其余状态抛错（HTTP 层 409）。
   *  UPDATE ... WHERE status='draft' 原子判定，affected=0 时读状态抛可读错误。 */
  async publish(taskId: string): Promise<TaskRecord> {
    const { affected } = await this.driver.run(
      "UPDATE ddw_tasks SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'draft'",
      [Date.now(), taskId],
    );
    if (affected === 0) {
      const rec = await this.get(taskId);
      throw new Error(rec ? `任务状态为 ${rec.status}，仅 draft 任务可发布` : `任务不存在: ${taskId}`);
    }
    return (await this.get(taskId))!;
  }

  /** 指定/取消指定员工（2026-09-06 分派分离）：pkg 是 JSON 列——先 get 再改 JSON 再写回，
   *  UPDATE ... WHERE status IN ('draft','pending') 原子判定，affected=0 时读状态抛可读错误。
   *  employeeId null 时从 pkg JSON 删除 assignee 键（不能留 null）。 */
  async assign(taskId: string, employeeId: string | null): Promise<TaskRecord> {
    const rec = await this.get(taskId);
    if (!rec) throw new Error(`任务不存在: ${taskId}`);
    if (rec.status !== 'draft' && rec.status !== 'pending') {
      throw new Error(`任务状态为 ${rec.status}，仅待发布/待分派任务可指定员工`);
    }
    let pkg: TaskPackage;
    if (employeeId === null) {
      // 删除键而非置 null：parseTaskPackage 语义 assignee 缺省 = 无点名
      pkg = structuredClone(rec.pkg);
      delete pkg.assignee;
    } else {
      pkg = { ...rec.pkg, assignee: employeeId };
    }
    const { affected } = await this.driver.run(
      "UPDATE ddw_tasks SET pkg = ?, updated_at = ? WHERE id = ? AND status IN ('draft','pending')",
      [this.driver.encodeJson(pkg), Date.now(), taskId],
    );
    if (affected === 0) {
      const now = await this.get(taskId);
      throw new Error(`任务状态为 ${now?.status ?? '不存在'}，仅待发布/待分派任务可指定员工`);
    }
    return (await this.get(taskId))!;
  }

  async get(taskId: string): Promise<TaskRecord | null> {
    const rows = await this.driver.all<TaskRow>(
      `SELECT ${COLS} FROM ddw_tasks WHERE id = ?`,
      [taskId],
    );
    return rows[0] ? this.rowToRecord(rows[0]) : null;
  }

  async list(): Promise<TaskRecord[]> {
    // 分派序 = 时间序（2026-09-11 P1 治理批）：创建/重提交先来先分派，id 字典序仅同毫秒平手裁决——
    // 此前 ORDER BY id（用户 taskId 字典序）与到达时间无关，晚提的字典序小任务反被先分派
    const rows = await this.driver.all<TaskRow>(`SELECT ${COLS} FROM ddw_tasks ORDER BY created_at ASC, id ASC`);
    return rows.map((r) => this.rowToRecord(r));
  }

  /** 接单：原子 claim（UPDATE 受影响行数判定），非 pending 抛错（HTTP 层映射 409） */
  async claim(taskId: string, employeeId: string): Promise<TaskRecord> {
    const { affected } = await this.driver.run(
      "UPDATE ddw_tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      [employeeId, Date.now(), Date.now(), taskId],
    );
    if (affected === 0) {
      const rec = await this.get(taskId);
      throw new Error(`任务状态为 ${rec?.status ?? '不存在'}，不可接单（仅 pending 可领取）`);
    }
    return (await this.get(taskId))!;
  }

  async markRunning(taskId: string): Promise<TaskRecord> {
    const { affected } = await this.driver.run(
      "UPDATE ddw_tasks SET status = 'running', updated_at = ? WHERE id = ?",
      [Date.now(), taskId],
    );
    if (affected === 0) throw new Error(`任务不存在: ${taskId}`);
    return (await this.get(taskId))!;
  }

  /** 回写执行结果（runtime 执行方调用）；计划模式附逐项进度与停点。
   *  progress/failedItemId 未传（undefined/null）时 COALESCE 保留旧值——与 file store
   *  语义对齐（fork crashOutcome 不带进度不得清空既有进度）；显式传值才覆盖。
   *  显式清空停点走 resumePlan（单独 SET failed_item_id = NULL）。 */
  async finish(taskId: string, outcome: EmployeeOutcome, ok: boolean, progress?: PlanProgress[], failedItemId?: string): Promise<TaskRecord> {
    const { affected } = await this.driver.run(
      `UPDATE ddw_tasks SET status = ?, result = ?,
        plan_progress = COALESCE(?, plan_progress), failed_item_id = COALESCE(?, failed_item_id), updated_at = ?
        WHERE id = ?`,
      [
        ok ? 'done' : 'failed',
        this.driver.encodeJson(outcome),
        progress ? this.driver.encodeJson(progress) : null,
        failedItemId ?? null,
        Date.now(),
        taskId,
      ],
    );
    if (affected === 0) throw new Error(`任务不存在: ${taskId}`);
    return (await this.get(taskId))!;
  }

  /** 强制重置（2026-09-11 P0 韧性批）：非 draft 任意状态 → pending，执行态窄列全清——
   *  与 add() 的 resetCols 同一清单。UPDATE ... WHERE status <> 'draft' 原子判定。 */
  async resetToPending(taskId: string): Promise<TaskRecord> {
    const { affected } = await this.driver.run(
      "UPDATE ddw_tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL, result = NULL, plan_progress = NULL, failed_item_id = NULL, updated_at = ? WHERE id = ? AND status <> 'draft'",
      [Date.now(), taskId],
    );
    if (affected === 0) {
      const rec = await this.get(taskId);
      throw new Error(rec
        ? (rec.status === 'draft' ? 'draft 任务直接发布即可，无需重置' : `任务不存在: ${taskId}`)
        : `任务不存在: ${taskId}`);
    }
    return (await this.get(taskId))!;
  }

  /** 计划续跑：仅 failed 可续（→pending，保留 progress，清停点）；其余状态抛错（HTTP 层 409）。
   *  UPDATE ... WHERE status='failed' 原子判定，affected=0 时读状态抛可读错误。
   *  失败项同步复位 skipped（待执行）——与 file store 语义一致，不残留「失败」标签（2026-09-06 用户反馈）。
   *  谁失败谁继续（2026-09-06 用户语义）：原执行员工（claimed_by）写为 pkg.assignee，
   *  调度器 acquireById 点名续接，不走岗位自动分派。
   *  SELECT+UPDATE 包进 driver.tx：sqlite 单连接同步天然原子，mysql 必须显式事务（spec §4）。 */
  async resumePlan(taskId: string): Promise<TaskRecord> {
    return this.driver.tx(async () => {
      const rows = await this.driver.all<Pick<TaskRow, 'pkg' | 'claimed_by' | 'plan_progress'>>(
        "SELECT pkg, claimed_by, plan_progress FROM ddw_tasks WHERE id = ? AND status = 'failed'",
        [taskId],
      );
      const row = rows[0];
      if (!row) {
        const rec = await this.get(taskId);
        throw new Error(`任务状态为 ${rec?.status ?? '不存在'}，仅 failed 任务可续跑`);
      }
      // 失败项 → skipped（待执行）；done 项原样保留（断点续跑从停点续）
      const progress = row.plan_progress
        ? (this.driver.decodeJson<PlanProgress[]>(row.plan_progress)).map((p) => (p.status === 'failed' ? { ...p, status: 'skipped' } : p))
        : null;
      // 谁失败谁继续：原执行员工点名续接（pkg.assignee 驱动调度器 acquireById）
      const pkg = this.driver.decodeJson<TaskPackage>(row.pkg);
      if (row.claimed_by) pkg.assignee = row.claimed_by;
      await this.driver.run(
        "UPDATE ddw_tasks SET status = 'pending', failed_item_id = NULL, plan_progress = ?, pkg = ?, updated_at = ? WHERE id = ? AND status = 'failed'",
        [progress ? this.driver.encodeJson(progress) : null, this.driver.encodeJson(pkg), Date.now(), taskId],
      );
      return (await this.get(taskId))!;
    });
  }
}
