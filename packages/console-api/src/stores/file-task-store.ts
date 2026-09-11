import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EmployeeOutcome, PlanProgress, TaskPackage } from '@ddw/runtime';
import type { TaskRecord, TaskStatus, TaskStore } from './types.js';

export type { TaskStatus, TaskRecord } from './types.js';

/** 任务池文件实现（测试 Fake / 极简部署）：一个任务包一条记录，JSON 落盘 `<dir>/tasks/<taskId>.json` */
export class FileTaskStore implements TaskStore {
  /** 状态变更串行化：claim 是 check-then-write，并发调用（双调度实例共享 store）下
   *  不串行会双双通过（P13-T4 用例抓出）。SQLite 实现靠 UPDATE...WHERE 原生原子，
   *  File 实现靠此队列；跨进程共享文件目录仍需 SQLite（本实现定位测试/极简部署）。 */
  private mutateQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private taskPath(taskId: string): string {
    // taskId 可能含斜杠（Jira key 等不会，但防御性展平）
    return join(this.dir, 'tasks', taskId.replaceAll('/', '_') + '.json');
  }

  private async write(rec: TaskRecord): Promise<TaskRecord> {
    await mkdir(join(this.dir, 'tasks'), { recursive: true });
    await writeFile(this.taskPath(rec.pkg.taskId), JSON.stringify(rec, null, 2), 'utf8');
    return rec;
  }

  async add(pkg: TaskPackage, opts?: { draft?: boolean }): Promise<TaskRecord> {
    const status: TaskStatus = opts?.draft ? 'draft' : 'pending';
    // createdAt（2026-09-11 P1 治理批）：分派序时间序的时间戳；重提交 = 重新排队刷新
    return this.write({ pkg, status, createdAt: Date.now() });
  }

  /** 发布（2026-09-06）：仅 draft → pending；其余状态抛错（HTTP 层 409） */
  async publish(taskId: string): Promise<TaskRecord> {
    return this.mutate(taskId, (rec) => {
      if (rec.status !== 'draft') throw new Error(`任务状态为 ${rec.status}，仅 draft 任务可发布`);
      return { ...rec, status: 'pending' };
    });
  }

  /** 指定/取消指定员工（2026-09-06 分派分离）：仅 draft/pending 可操作；
   *  employeeId null 时从 pkg 删除 assignee 键（不能留 null），非 null 写 pkg.assignee */
  async assign(taskId: string, employeeId: string | null): Promise<TaskRecord> {
    return this.mutate(taskId, (rec) => {
      if (rec.status !== 'draft' && rec.status !== 'pending') {
        throw new Error(`任务状态为 ${rec.status}，仅待发布/待分派任务可指定员工`);
      }
      if (employeeId === null) {
        // 删除键而非置 null：parseTaskPackage 语义 assignee 缺省 = 无点名（mutate 内 rec 为新解析副本，可原地改）
        delete rec.pkg.assignee;
        return rec;
      }
      return { ...rec, pkg: { ...rec.pkg, assignee: employeeId } };
    });
  }

  async get(taskId: string): Promise<TaskRecord | null> {
    try {
      return JSON.parse(await readFile(this.taskPath(taskId), 'utf8')) as TaskRecord;
    } catch {
      return null;
    }
  }

  async list(): Promise<TaskRecord[]> {
    const dir = join(this.dir, 'tasks');
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const records = await Promise.all(
      files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as TaskRecord),
    );
    // 分派序 = 时间序（2026-09-11 P1 治理批，与 SqlTaskStore 同语义）：先创建先分派；
    // 旧记录无 createdAt（0）排最前 = 旧任务确实更早；taskId 仅同毫秒平手裁决
    return records.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.pkg.taskId.localeCompare(b.pkg.taskId));
  }

  private mutate(taskId: string, fn: (rec: TaskRecord) => TaskRecord): Promise<TaskRecord> {
    // 排队执行（失败不毒化队列）：保 check-then-write 原子性与变更序
    const run = this.mutateQueue.then(() => this.mutateInner(taskId, fn));
    this.mutateQueue = run.catch(() => undefined);
    return run;
  }

  private async mutateInner(taskId: string, fn: (rec: TaskRecord) => TaskRecord): Promise<TaskRecord> {
    const rec = await this.get(taskId);
    if (!rec) throw new Error(`任务不存在: ${taskId}`);
    return this.write(fn(rec));
  }

  /** 接单：pending → claimed；已被领取/执行中抛错（HTTP 层映射 409） */
  async claim(taskId: string, employeeId: string): Promise<TaskRecord> {
    return this.mutate(taskId, (rec) => {
      if (rec.status !== 'pending') throw new Error(`任务状态为 ${rec.status}，不可接单（仅 pending 可领取）`);
      return { ...rec, status: 'claimed', claimedBy: employeeId, claimedAt: Date.now() };
    });
  }

  /** 回写执行结果（runtime 执行方调用）；计划模式附逐项进度与停点 */
  async finish(taskId: string, outcome: EmployeeOutcome, ok: boolean, progress?: PlanProgress[], failedItemId?: string): Promise<TaskRecord> {
    return this.mutate(taskId, (rec) => ({
      ...rec,
      status: ok ? 'done' : 'failed',
      result: outcome,
      ...(progress ? { planProgress: progress } : {}),
      ...(failedItemId ? { failedItemId } : {}),
    }));
  }

  /** 计划续跑：仅 failed 可续（→pending，保留 progress，清停点）；其余状态抛错（HTTP 层 409）。
   *  失败项复位为 skipped（待执行）——不残留「失败」标签等下一轮执行结束才覆盖（2026-09-06 用户反馈）。
   *  谁失败谁继续（2026-09-06 用户语义）：原执行员工写为 pkg.assignee，调度器 acquireById
   *  点名续接（不走岗位自动分派）；原员工不在/停用时留痕「指定员工不可用」等人工改派 */
  async resumePlan(taskId: string): Promise<TaskRecord> {
    return this.mutate(taskId, (rec) => {
      if (rec.status !== 'failed') throw new Error(`任务状态为 ${rec.status}，仅 failed 任务可续跑`);
      return {
        ...rec,
        status: 'pending',
        failedItemId: undefined,
        planProgress: rec.planProgress?.map((p) => (p.status === 'failed' ? { ...p, status: 'skipped' } : p)),
        pkg: rec.claimedBy ? { ...rec.pkg, assignee: rec.claimedBy } : rec.pkg,
      };
    });
  }

  /** 标记执行中（接单后、执行前） */
  async markRunning(taskId: string): Promise<TaskRecord> {
    return this.mutate(taskId, (rec) => ({ ...rec, status: 'running' }));
  }

  /** 强制重置（2026-09-11 P0 韧性批）：非 draft 任意状态 → pending，执行态全清（与 Sql 实现同语义） */
  async resetToPending(taskId: string): Promise<TaskRecord> {
    return this.mutate(taskId, (rec) => {
      if (rec.status === 'draft') throw new Error('draft 任务直接发布即可，无需重置');
      return {
        pkg: rec.pkg,
        status: 'pending',
      };
    });
  }
}
