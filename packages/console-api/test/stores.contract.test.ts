import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTaskStore, FileEventStore, SqlTaskStore, SqlEventStore } from '../src/stores/index.js';
import type { TaskStore, EventStore } from '../src/stores/index.js';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import { createMysqlDriver } from '../src/stores/sql/mysql-driver.js';
import { mysqlTestUrl, resetMysqlTestDb } from './helpers/mysql.js';
import { GENESIS_HASH, canonicalContent, computeHash } from '../src/stores/hash-chain.js';
import { parseTaskPackage } from '@ddw/runtime';
import type { AgentEvent } from '@ddw/runtime';

const YAML = await readFile(new URL('../../../examples/task-package.example.yaml', import.meta.url), 'utf8');

/** mysql 契约组内共享驱动（惰性建）与快照临时目录（组内变量，凭据只经 env，不入任何文件） */
let mysqlDriver: Awaited<ReturnType<typeof createMysqlDriver>> | undefined;
let dir: string;

/**
 * 存储契约测试（spec 5.2 中间层）：同一组用例对任意 TaskStore/EventStore 实现跑一遍，
 * 保证「换库 = 换注入，行为不变」。新增实现（如 MySql）只需再调一次 makeStoreContract。
 */
export function makeStoreContract(
  name: string,
  create: () => Promise<{
    tasks: TaskStore;
    events: EventStore;
    /** 篡改事件流（改一条事件的 summary 落库），用于 hash 链断链验证 */
    tamper: () => Promise<void>;
    /** 篡改 + 重算整条 hash 链落库（模拟最高级攻击者：链重算自洽，只有库外快照能检测） */
    tamperWithRechain: () => Promise<void>;
    cleanup: () => Promise<void>;
  }>,
): void {
  describe(`存储契约 · ${name}`, () => {
    let tasks: TaskStore;
    let events: EventStore;
    let tamper: () => Promise<void>;
    let tamperWithRechain: () => Promise<void>;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ tasks, events, tamper, tamperWithRechain, cleanup } = await create());
    });
    afterEach(async () => {
      await cleanup();
    });

    it('task: add → get 往返一致；get 不存在返回 null', async () => {
      const pkg = parseTaskPackage(YAML);
      await tasks.add(pkg);
      const rec = await tasks.get(pkg.taskId);
      expect(rec).not.toBeNull();
      expect(rec!.pkg.title).toBe(pkg.title);
      expect(rec!.status).toBe('pending');
      expect(await tasks.get('NOPE')).toBeNull();
    });

    it('draft 发布态：add({draft:true}) 初始 draft 不可 claim，publish 后 pending 可 claim（2026-09-06）', async () => {
      const pkg = parseTaskPackage(YAML);
      const rec = await tasks.add(pkg, { draft: true });
      expect(rec.status).toBe('draft');
      await expect(tasks.claim(pkg.taskId, 'emp-01')).rejects.toThrow(/不可接单/);
      const published = await tasks.publish(pkg.taskId);
      expect(published.status).toBe('pending');
      await tasks.claim(pkg.taskId, 'emp-01'); // 发布后可正常接单
      expect((await tasks.get(pkg.taskId))?.status).toBe('claimed');
    });

    it('publish 仅 draft 可发布：非 draft 抛可读错误；add 缺省仍 pending（零回归）', async () => {
      const pkg = parseTaskPackage(YAML);
      expect((await tasks.add(pkg)).status).toBe('pending'); // 缺省行为零变化
      await expect(tasks.publish(pkg.taskId)).rejects.toThrow(/仅 draft 任务可发布/);
      await expect(tasks.publish('NOPE')).rejects.toThrow(/任务不存在/);
    });

    it('task: claim 状态机 pending→claimed→running→done；非 pending 拒绝', async () => {
      const pkg = parseTaskPackage(YAML);
      const taskId = pkg.taskId;
      await tasks.add(pkg);

      const claimed = await tasks.claim(taskId, 'emp-01');
      expect(claimed.status).toBe('claimed');
      expect(claimed.claimedBy).toBe('emp-01');
      expect(claimed.claimedAt).toBeGreaterThan(0);

      await expect(tasks.claim(taskId, 'emp-02')).rejects.toThrow('不可接单');

      await tasks.markRunning(taskId);
      expect((await tasks.get(taskId))!.status).toBe('running');
      await expect(tasks.claim(taskId, 'emp-02')).rejects.toThrow('不可接单');

      const done = await tasks.finish(taskId, { status: 'done', reply: 'ok', turns: 3 }, true);
      expect(done.status).toBe('done');
      expect(done.result?.reply).toBe('ok');
      expect(await tasks.get(taskId)).toMatchObject({ status: 'done' });
    });

    it('task: 并发 claim 原子性——并发抢单恰好一次成功（P13 多实例调度安全）', async () => {
      const pkg = parseTaskPackage(YAML);
      await tasks.add(pkg);
      // 8 路并发抢单：仅一路拿到 claimed，其余全部被拒（File 串行化 / SQLite UPDATE WHERE 原子）
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => tasks.claim(pkg.taskId, `emp-${i}`)),
      );
      const won = results.filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      expect((await tasks.get(pkg.taskId))!.claimedBy).toBe('emp-0');
    });

    it('task: assign 指定/取消指定员工（2026-09-06 分派分离）：仅 draft/pending 可操作', async () => {
      const pkg = parseTaskPackage(YAML);
      await tasks.add(pkg, { draft: true });
      // draft 可指定
      const assigned = await tasks.assign(pkg.taskId, 'emp-01');
      expect(assigned.status).toBe('draft');
      expect(assigned.pkg.assignee).toBe('emp-01');
      // 取消指定：assignee 键从 pkg 删除（不能留 null）
      const cleared = await tasks.assign(pkg.taskId, null);
      expect('assignee' in cleared.pkg).toBe(false);
      expect((await tasks.get(pkg.taskId))!.pkg.assignee).toBeUndefined();
      // publish 后 pending 可改派
      await tasks.publish(pkg.taskId);
      const reassigned = await tasks.assign(pkg.taskId, 'emp-02');
      expect(reassigned.status).toBe('pending');
      expect(reassigned.pkg.assignee).toBe('emp-02');
      // claimed 拒绝（其余状态同理，HTTP 层 409）
      await tasks.claim(pkg.taskId, 'emp-01');
      await expect(tasks.assign(pkg.taskId, 'emp-03')).rejects.toThrow(/仅待发布\/待分派任务可指定员工/);
      // 不存在的任务抛错
      await expect(tasks.assign('NOPE', 'emp-01')).rejects.toThrow(/任务不存在/);
    });

    it('task: finish(ok=false) → failed；list 返回全部记录', async () => {
      const pkg = parseTaskPackage(YAML);
      await tasks.add(pkg);
      await tasks.claim(pkg.taskId, 'emp-01');
      await tasks.finish(pkg.taskId, { status: 'done', reply: '失败原因', turns: 2 }, false);
      expect((await tasks.get(pkg.taskId))!.status).toBe('failed');

      const pkg2 = parseTaskPackage(YAML.replace('taskId: TASK-2026-0912-001', 'taskId: TASK-2026-0912-002'));
      await tasks.add(pkg2);
      expect((await tasks.list()).length).toBe(2);
    });

    it('task: 终态后重提交窄列清空——重跑不得串上一轮 claimedBy/result/进度（T2 评审 P1）', async () => {
      const pkg = parseTaskPackage(YAML);
      await tasks.add(pkg);
      await tasks.claim(pkg.taskId, 'emp-01');
      // finish 携带 progress + failedItemId：验证 COALESCE 残留的进度与停点也被清
      const failed = await tasks.finish(
        pkg.taskId,
        { status: 'done', reply: '第 2 项失败', turns: 5 },
        false,
        [{ itemId: 'item-1', kind: 'command', title: '步骤1', status: 'done' }, { itemId: 'item-2', kind: 'command', title: '步骤2', status: 'failed' }],
        'item-2',
      );
      expect(failed.claimedBy).toBe('emp-01');
      expect(failed.planProgress).toHaveLength(2);
      expect(failed.failedItemId).toBe('item-2');

      // 重提交同 taskId（旧 INSERT OR REPLACE / 新 upsert resetCols 均须覆盖清残留）
      await tasks.add(pkg);
      const rec = await tasks.get(pkg.taskId);
      expect(rec!.status).toBe('pending');
      expect(rec!.claimedBy).toBeUndefined();
      expect(rec!.claimedAt).toBeUndefined();
      expect(rec!.result).toBeUndefined();
      expect(rec!.planProgress).toBeUndefined();
      expect(rec!.failedItemId).toBeUndefined();
    });

    it('task: 重提交 draft 变体——终态任务重提为 draft，窄列清空且状态 draft', async () => {
      const pkg = parseTaskPackage(YAML);
      await tasks.add(pkg);
      await tasks.claim(pkg.taskId, 'emp-01');
      await tasks.finish(pkg.taskId, { status: 'done', reply: 'ok', turns: 1 }, true);
      expect((await tasks.get(pkg.taskId))!.claimedBy).toBe('emp-01');

      await tasks.add(pkg, { draft: true });
      const rec = await tasks.get(pkg.taskId);
      expect(rec!.status).toBe('draft');
      expect(rec!.claimedBy).toBeUndefined();
      expect(rec!.claimedAt).toBeUndefined();
      expect(rec!.result).toBeUndefined();
      // draft 重提后照常可走 publish 流程
      expect((await tasks.publish(pkg.taskId)).status).toBe('pending');
    });

    it('task: resetToPending 强制重置（2026-09-11 P0 韧性批）——非 draft 任意状态清执行态回 pending', async () => {
      const pkg = parseTaskPackage(YAML);
      await tasks.add(pkg);
      await tasks.claim(pkg.taskId, 'emp-01');
      await tasks.markRunning(pkg.taskId);
      // 卡死场景带全部执行残留：result/progress/停点（running 未 finish 没有这些，用 failed 路径补验）
      await tasks.finish(
        pkg.taskId,
        { status: 'done', reply: '中断', turns: 2 },
        false,
        [{ itemId: 'item-1', kind: 'command', title: '步骤1', status: 'done' }],
        'item-1',
      );
      // failed → resetToPending 也必须支持（孤儿扫描标 failed 后管理员的重新执行通道）
      const reset = await tasks.resetToPending(pkg.taskId);
      expect(reset.status).toBe('pending');
      const rec = await tasks.get(pkg.taskId);
      expect(rec!.status).toBe('pending');
      expect(rec!.claimedBy).toBeUndefined();
      expect(rec!.claimedAt).toBeUndefined();
      expect(rec!.result).toBeUndefined();
      expect(rec!.planProgress).toBeUndefined();
      expect(rec!.failedItemId).toBeUndefined();

      // pending 终态后重置：执行态本就空，幂等回 pending
      expect((await tasks.resetToPending(pkg.taskId)).status).toBe('pending');

      // draft 不可重置（draft 语义 = 改稿发布，不该有执行态要清）
      const pkg2 = parseTaskPackage(YAML.replace('taskId: TASK-2026-0912-001', 'taskId: TASK-2026-0912-003'));
      await tasks.add(pkg2, { draft: true });
      await expect(tasks.resetToPending(pkg2.taskId)).rejects.toThrow(/draft/);
      // 不存在同理抛可读错误
      await expect(tasks.resetToPending('NOPE')).rejects.toThrow();
    });

    it('task: list 时间序分派（2026-09-11 P1 治理批）——按入池顺序返回，记录带 createdAt', async () => {
      const pkgA = parseTaskPackage(YAML.replace('taskId: TASK-2026-0912-001', 'taskId: TASK-A'));
      const pkgB = parseTaskPackage(YAML.replace('taskId: TASK-2026-0912-001', 'taskId: TASK-B'));
      const a = await tasks.add(pkgA);
      const b = await tasks.add(pkgB);
      // createdAt 随记录返回（File/Sql 均落 Date.now()；同毫秒由次序键保序）
      expect(a.createdAt).toBeGreaterThan(0);
      expect(b.createdAt).toBeGreaterThanOrEqual(a.createdAt!);
      expect((await tasks.list()).map((r) => r.pkg.taskId)).toEqual(['TASK-A', 'TASK-B']);
    });

    it('event: append → list 升序；taskId/employeeId/type/since 过滤；since 为 >= 语义', async () => {
      const ev = (id: string, ts: number, over: Partial<AgentEvent> = {}): AgentEvent => ({
        id, ts, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: id, ...over,
      });
      await events.append(ev('e1', 1000));
      await events.append(ev('e2', 2000, { taskId: 'T2' }));
      await events.append(ev('e3', 3000, { taskId: 'T2', type: 'thinking' }));
      await events.append(ev('e4', 2000)); // 同毫秒（与 e2 相同 ts）

      expect((await events.list()).map((e) => e.id)).toEqual(['e1', 'e2', 'e4', 'e3']);
      expect((await events.list({ taskId: 'T1' })).map((e) => e.id)).toEqual(['e1', 'e4']);
      expect((await events.list({ type: 'thinking' })).map((e) => e.id)).toEqual(['e3']);
      expect((await events.list({ employeeId: 'emp-01' })).length).toBe(4);
      // since >= 语义（at-least-once）：ts=2000 的事件全部返回
      expect((await events.list({ since: 2000 })).map((e) => e.id)).toEqual(['e2', 'e4', 'e3']);
    });

    it('audit hash 链：全链校验通过；篡改任一事件后 brokenAt 定位断点', async () => {
      const ev = (id: string, ts: number): AgentEvent => ({
        id, ts, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: id,
      });
      await events.append(ev('e1', 1000));
      await events.append(ev('e2', 2000));
      await events.append(ev('e3', 3000));

      expect(events.verifyIntegrity).toBeTypeOf('function'); // 契约要求支持链
      expect(await events.verifyIntegrity!()).toEqual({ ok: true, total: 3 });

      await tamper(); // 改 e2 的 summary 落库
      const report = await events.verifyIntegrity!();
      expect(report.ok).toBe(false);
      expect(report.brokenAt).toBe('e2');
      expect(report.total).toBe(3);
    });

    it('audit 快照：snapshotHead 归档链头后校验通过，追加新事件不影响', async () => {
      const ev = (id: string, ts: number): AgentEvent => ({
        id, ts, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: id,
      });
      await events.append(ev('e1', 1000));
      await events.append(ev('e2', 2000));
      await events.append(ev('e3', 3000));

      expect(events.snapshotHead).toBeTypeOf('function'); // 契约要求支持快照
      const head = await events.snapshotHead!();
      expect(head.id).toBe('e3');

      await events.append(ev('e4', 4000)); // 快照之后的新事件不在保护范围
      const report = await events.verifyIntegrity!();
      expect(report.ok).toBe(true);
      expect(report.headSnapshot).toEqual({ ok: true, checked: 1 });
    });

    it('audit 快照：篡改并重算整条链——链重算自洽，但库外快照暴露篡改', async () => {
      const ev = (id: string, ts: number): AgentEvent => ({
        id, ts, taskId: 'T1', employeeId: 'emp-01', type: 'tool_call', summary: id,
      });
      await events.append(ev('e1', 1000));
      await events.append(ev('e2', 2000));
      await events.append(ev('e3', 3000));
      await events.snapshotHead!(); // 快照点 = 当时链头 e3
      await events.append(ev('e4', 4000));
      await events.append(ev('e5', 5000));

      // 攻击者改 e2 的 summary 并重算 e2→e5 全部 prev/hash 落库：verifyChain 重算自洽（brokenAt 无）
      await tamperWithRechain();
      const report = await events.verifyIntegrity!();
      expect(report.brokenAt).toBeUndefined(); // 全链重算发现不了
      expect(report.ok).toBe(false);
      expect(report.headSnapshot?.ok).toBe(false);
      expect(report.headSnapshot?.brokenAt).toBe('e3'); // 首个失配的快照点
    });
  });
}

// 试点两实现跑同一契约：换库 = 组装处换一行，业务端行为不变（spec 5.2）
makeStoreContract('file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ddw-contract-file-'));
  return {
    tasks: new FileTaskStore(dir),
    events: new FileEventStore(dir),
    tamper: async () => {
      const jsonl = join(dir, 'events.jsonl');
      const lines = (await readFile(jsonl, 'utf8')).split('\n').filter(Boolean);
      const evil = JSON.parse(lines[1]!); // e2
      evil.summary = '被篡改';
      lines[1] = JSON.stringify(evil);
      await writeFile(jsonl, lines.join('\n') + '\n', 'utf8');
    },
    tamperWithRechain: async () => {
      const jsonl = join(dir, 'events.jsonl');
      const all = (await readFile(jsonl, 'utf8')).split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as AgentEvent & { prevHash?: string; hash?: string });
      let prev = GENESIS_HASH;
      const out = all.map((e, i) => {
        if (i === 1) e.summary = '被篡改';
        e.prevHash = prev;
        e.hash = computeHash(canonicalContent(e), prev);
        prev = e.hash;
        return e;
      });
      await writeFile(jsonl, out.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});

makeStoreContract('sqlite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ddw-contract-sqlite-'));
  // 存储企业化：任务池/事件流共用同一 SqlDriver（SqlTaskStore + SqlEventStore + ddw_tasks/ddw_events）；
  // 链头快照路径显式传入（对应旧 `<dbPath>.heads.jsonl` 落点）
  const driver = new SqliteDriver(join(dir, 'ddw.sqlite'));
  await driver.ensureSchema();
  return {
    tasks: new SqlTaskStore(driver),
    events: new SqlEventStore(driver, { headsPath: join(dir, 'ddw.sqlite.heads.jsonl') }),
    tamper: async () => {
      const db = new DatabaseSync(join(dir, 'ddw.sqlite'));
      db.prepare("UPDATE ddw_events SET summary = '被篡改' WHERE id = 'e2'").run();
      db.close();
    },
    tamperWithRechain: async () => {
      const db = new DatabaseSync(join(dir, 'ddw.sqlite'));
      const rows = db
        .prepare('SELECT id, ts, task_id, employee_id, type, summary, payload FROM ddw_events ORDER BY seq ASC')
        .all() as unknown as { id: string; ts: number; task_id: string; employee_id: string; type: string; summary: string; payload: string | null }[];
      let prev = GENESIS_HASH;
      for (const [i, r] of rows.entries()) {
        const summary = i === 1 ? '被篡改' : r.summary;
        const e: AgentEvent = {
          id: r.id, ts: r.ts, taskId: r.task_id, employeeId: r.employee_id,
          type: r.type as AgentEvent['type'], summary,
          ...(r.payload ? { payload: JSON.parse(r.payload) as Record<string, unknown> } : {}),
        };
        const hash = computeHash(canonicalContent(e), prev);
        db.prepare('UPDATE ddw_events SET summary = ?, prev_hash = ?, hash = ? WHERE id = ?').run(summary, prev, hash, r.id);
        prev = hash;
      }
      db.close();
    },
    cleanup: async () => {
      await driver.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
});

// mysql 契约（Task 4）：设 DDW_TEST_MYSQL_URL 才注册真跑（缺 env 时 mysql 契约整组缺席，离线安全）。
// 同一组契约断言跑 MysqlDriver——「换库 = 换注入，行为不变」的最终验证。
const mysqlContractUrl = process.env.DDW_TEST_MYSQL_URL;
if (mysqlContractUrl) {
  makeStoreContract('mysql', async () => {
    // 惰性单例驱动：首次 create 时重建测试库（强制改写独立库名，vitest 并行下不踩其他文件的库）
    // + ensureSchema；表数据每用例清空隔离
    if (!mysqlDriver) {
      const db = 'ddw_test_contract';
      await resetMysqlTestDb(mysqlContractUrl, db);
      mysqlDriver = await createMysqlDriver(mysqlTestUrl(mysqlContractUrl, db));
      await mysqlDriver.ensureSchema();
    }
    await mysqlDriver.exec('DELETE FROM ddw_tasks');
    await mysqlDriver.exec('DELETE FROM ddw_events');
    dir = await mkdtemp(join(tmpdir(), 'ddw-contract-mysql-'));
    return {
      tasks: new SqlTaskStore(mysqlDriver!),
      events: new SqlEventStore(mysqlDriver!, { headsPath: join(dir, 'heads.jsonl') }),
      tamper: async () => {
        await mysqlDriver!.exec("UPDATE ddw_events SET summary = '被篡改' WHERE id = 'e2'");
      },
      tamperWithRechain: async () => {
        // 模拟最高级攻击者：改 e2 summary 并重算 e2→末尾全部 prev/hash 落库（链重算自洽）
        const rows = await mysqlDriver!.all<{
          id: string; ts: number; task_id: string; employee_id: string; type: string; summary: string; payload: unknown;
        }>('SELECT id, ts, task_id, employee_id, type, summary, payload FROM ddw_events ORDER BY seq ASC');
        let prev = GENESIS_HASH;
        for (const [i, r] of rows.entries()) {
          const summary = i === 1 ? '被篡改' : r.summary;
          const e: AgentEvent = {
            id: r.id, ts: r.ts, taskId: r.task_id, employeeId: r.employee_id,
            type: r.type as AgentEvent['type'], summary,
            ...(r.payload ? { payload: mysqlDriver!.decodeJson<Record<string, unknown>>(r.payload) } : {}),
          };
          const hash = computeHash(canonicalContent(e), prev);
          await mysqlDriver!.run('UPDATE ddw_events SET summary = ?, prev_hash = ?, hash = ? WHERE id = ?',
            [summary, prev, hash, r.id]);
          prev = hash;
        }
      },
      cleanup: async () => {
        // 驱动为组内单例不 close（库可留，表数据即弃）；仅清理快照临时目录
        if (dir) await rm(dir, { recursive: true, force: true });
      },
    };
  });
}
