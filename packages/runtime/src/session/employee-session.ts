import { join } from 'node:path';
import { JsonlSessionRepo, type Session, type AgentMessage } from '@earendil-works/pi-agent-core';
import { makeNodeFs } from '../fs/node-fs.js';

/** 任务级 session 存储：taskId ↔ pi session 一对一（session 即 checkpoint，消息级实时落盘）。 */
export class EmployeeSessionStore {
  private repo: JsonlSessionRepo;

  constructor(private readonly root: string) {
    this.repo = new JsonlSessionRepo({
      fs: makeNodeFs(root),
      sessionsRoot: join(root, 'sessions'),
    });
  }

  /** 幂等：同 taskId 首次 create、后续 open 同一 session。 */
  async open(taskId: string): Promise<Session> {
    const taskDir = join(this.root, 'tasks', taskId);
    const existing = (await this.repo.list()).find(
      (m) => (m as { cwd?: string }).cwd === taskDir,
    );
    return existing ? this.repo.open(existing) : this.repo.create({ cwd: taskDir });
  }

  /** 删除该任务的 session（任务从零重跑时清残留，避免续上旧上下文）。幂等：无 session 时 no-op。 */
  async remove(taskId: string): Promise<void> {
    const taskDir = join(this.root, 'tasks', taskId);
    // 全删：历史遗留的同 cwd 重复 session 只删首个会漏清（open 幂等会捡起另一条）
    const stale = (await this.repo.list()).filter(
      (m) => (m as { cwd?: string }).cwd === taskDir,
    );
    for (const m of stale) await this.repo.delete(m);
  }
}

/** 读回消息（时间序）。P0 铁律 4：findEntries 是 newest-first，必须 reverse。 */
export async function loadMessages(session: Session): Promise<AgentMessage[]> {
  const entries = await session.findEntries();
  return entries
    .filter((e) => e.type === 'message')
    .map((e) => (e as { message: AgentMessage }).message)
    .reverse();
}
