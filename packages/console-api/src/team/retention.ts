import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * workspace/session 磁盘治理（2026-09-11 P1 治理批）：
 * done/failed 任务的 workspace（含 git clone 产物）与 session 会话文件此前永不清理，
 * 磁盘只增不减；重跑同名任务也只清当时的目录。
 *
 * 清扫策略 = 目录 mtime TTL（非任务状态驱动）：
 * - `<workspaceRoot>/<employeeId>/<taskIdDir>/` 与 `<sessionsRoot>/<employeeId>/tasks/<taskIdDir>/`
 *   目录 mtime 早于 cutoff 即整目录删除；
 * - mtime 驱动天然覆盖孤儿目录（任务重置/重提交后旧员工的残留、甚至任务记录已变的目录）；
 * - 活跃任务安全：执行持续写文件（clone/构建）mtime 恒新；看门狗保证执行最长 taskTimeoutMs，
 *   TTL（天级）远大于合法执行跨度，不存在误删活跃工作区。
 * - ddw_events 一条不删（hash 链审计合规红线）——治理只动文件系统。
 */

/** 单目录 mtime（不存在返回 null——并发删除竞态按无处理） */
async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** 清扫一个「员工根目录」下的任务子目录（subdirs 每项 = 相对员工根的子路径段），返回删除的任务目录名列表 */
async function sweepEmployeeDir(root: string, employeeId: string, subdirs: string[][], cutoffMs: number): Promise<string[]> {
  const removed: string[] = [];
  for (const sub of subdirs) {
    const target = join(root, employeeId, ...sub);
    const m = await mtimeOf(target);
    if (m === null || m >= cutoffMs) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(`${employeeId}/${sub.join('/')}`);
  }
  return removed;
}

/** 枚举 `<root>` 下一层员工目录（不存在/空返回 []） */
async function employeeDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 一轮清扫：workspaceRoot 与 sessionsRoot 下全部员工 × 全部任务目录按 TTL 删除。
 * 返回被删目录清单（留痕/测试断言用）。days <= 0 直接空转（配置关闭语义）。
 */
export async function sweepWorkspaces(
  roots: { workspaceRoot: string; sessionsRoot: string },
  days: number,
): Promise<string[]> {
  if (days <= 0) return [];
  const cutoff = Date.now() - days * 86_400_000;
  const removed: string[] = [];

  // workspace：一层 = 员工，二层 = 任务目录
  for (const emp of await employeeDirs(roots.workspaceRoot)) {
    const tasks = await readdir(join(roots.workspaceRoot, emp), { withFileTypes: true }).catch(() => []);
    const taskDirs = tasks.filter((t) => t.isDirectory()).map((t) => [t.name]);
    removed.push(...(await sweepEmployeeDir(roots.workspaceRoot, emp, taskDirs, cutoff)));
  }

  // sessions：`<sessionsRoot>/<employeeId>/tasks/<taskId>/`（同员工根下 sessions/ 为会话索引目录，不在任务粒度，不动）
  for (const emp of await employeeDirs(roots.sessionsRoot)) {
    const tasksDir = join(roots.sessionsRoot, emp, 'tasks');
    const tasks = await readdir(tasksDir, { withFileTypes: true }).catch(() => []);
    const taskDirs = tasks.filter((t) => t.isDirectory()).map((t) => ['tasks', t.name]);
    removed.push(...(await sweepEmployeeDir(roots.sessionsRoot, emp, taskDirs, cutoff)));
  }

  return removed;
}
