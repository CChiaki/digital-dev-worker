import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 消息类型（消息中心 2026-09-06）：待放行 / 任务失败 / 任务完成 / Skill 沉淀待审查 */
export type MessageType = 'review_required' | 'task_failed' | 'task_done' | 'skill_pending';

export interface MessageRecord {
  id: string;
  type: MessageType;
  title: string;
  summary: string;
  taskId: string;
  employeeId?: string;
  createdAt: number;
  /** 已读时间戳（服务端存已读状态） */
  readAt?: number;
}

/** 只保留最近 1000 条，超限丢最旧 */
const MAX_MESSAGES = 1000;

/** 新增消息（id/createdAt 由 store 补齐；id 允许调用方指定） */
export type NewMessage = Omit<MessageRecord, 'id' | 'createdAt' | 'readAt'> & { id?: string };

/** list 过滤项（2026-09-10 消息中心重设计）：type 按类型 / q 关键词（标题/摘要/任务 id）/ unreadOnly 只看未读 */
export interface MessageListOpts {
  unreadOnly?: boolean;
  type?: string;
  q?: string;
}

export interface MessageStore {
  /** list 默认最新在前；按 opts 过滤（2026-09-10 消息中心过滤查询） */
  list(opts?: MessageListOpts): Promise<MessageRecord[]>;
  unreadCount(): Promise<number>;
  add(m: NewMessage): Promise<MessageRecord>;
  /** 标记已读；消息不存在返回 false */
  markRead(id: string): Promise<boolean>;
  /** 全部标记已读（已读的不动），返回本次标记条数 */
  markAllRead(): Promise<number>;
}

/** JSON 文本 → 消息数组（非数组形状抛可读错误，防止损坏数据进入缓存） */
function parseMessages(raw: string): MessageRecord[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('消息文件格式错误: 应为对象数组');
  return parsed as MessageRecord[];
}

/** 仅 ENOENT 视为"文件不存在"；其余读/解析错误原样上抛（损坏/权限不得被当作不存在） */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** 消息中心文件实现：单 JSON 文件 + mutate 队列串行化（模式同 FileCapabilityStore，最新在前 + 1000 条上限） */
export class FileMessageStore implements MessageStore {
  private cache: MessageRecord[] | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async load(): Promise<MessageRecord[]> {
    if (this.cache) return this.cache;
    try {
      this.cache = parseMessages(await readFile(this.filePath, 'utf8'));
    } catch (err) {
      // 仅"文件不存在"视为尚未初始化；损坏/权限等其他读错误原样上抛，
      // 不得静默降级为空表缓存（否则 flush 会把残缺数据写回）
      if (isEnoent(err)) {
        this.cache = [];
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  private async flush(messages: MessageRecord[]): Promise<void> {
    this.cache = messages;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.messages-${process.pid}.tmp`);
    await writeFile(tmpPath, JSON.stringify(messages, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }

  async list(opts?: MessageListOpts): Promise<MessageRecord[]> {
    const messages = await this.load();
    const q = opts?.q?.toLowerCase();
    const filtered = messages.filter((m) =>
      (!opts?.unreadOnly || m.readAt === undefined)
      && (!opts?.type || m.type === opts.type)
      && (!q
        || m.title.toLowerCase().includes(q)
        || m.summary.toLowerCase().includes(q)
        || m.taskId.toLowerCase().includes(q)));
    return filtered.map((m) => structuredClone(m));
  }

  async unreadCount(): Promise<number> {
    return (await this.load()).filter((m) => m.readAt === undefined).length;
  }

  add(m: NewMessage): Promise<MessageRecord> {
    const run = this.queue.then(async () => {
      const messages = await this.load();
      const rec: MessageRecord = {
        ...m,
        id: m.id ?? randomUUID(),
        createdAt: Date.now(),
      };
      // 最新在前 + 超限丢最旧
      messages.unshift(rec);
      await this.flush(messages.slice(0, MAX_MESSAGES));
      return structuredClone(rec);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  markRead(id: string): Promise<boolean> {
    const run = this.queue.then(async () => {
      const messages = await this.load();
      const target = messages.find((m) => m.id === id);
      if (!target) return false;
      if (target.readAt === undefined) {
        target.readAt = Date.now();
        await this.flush(messages);
      }
      return true;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  markAllRead(): Promise<number> {
    const run = this.queue.then(async () => {
      const messages = await this.load();
      const now = Date.now();
      let marked = 0;
      for (const m of messages) {
        if (m.readAt === undefined) {
          m.readAt = now;
          marked++;
        }
      }
      if (marked > 0) await this.flush(messages);
      return marked;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
