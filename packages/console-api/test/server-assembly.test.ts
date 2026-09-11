import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelSpec, RouteConfig } from '@ddw/runtime';
import { parseTaskPackage } from '@ddw/runtime';
import { hasChatRoute, startConsoleServer } from '../src/http/server.js';
import { SqlTaskStore, SqlEmployeeStore } from '../src/stores/index.js';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import type { ConsoleRuntimeConfig } from '../src/team/runtime-config.js';

// node:http 打桩（2026-09-06 消息中心接线防回归测试）：createServer 不真实 listen（测试不监听端口、不启动服务），
// 仅捕获 startConsoleServer 装配出的 handler，直接调用验证依赖接线。
const httpMock = vi.hoisted(() => {
  const state: { handler?: (req: unknown, res: unknown) => Promise<void> } = {};
  return state;
});

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  const fakeServer = {
    listen: () => fakeServer,
    on: () => fakeServer,
    close: () => fakeServer,
  };
  return {
    ...actual,
    createServer: (handler: (req: unknown, res: unknown) => Promise<void>) => {
      httpMock.handler = handler;
      return fakeServer;
    },
  } as unknown as typeof actual;
});

const spec: ModelSpec = { name: 'glm-test', baseUrl: 'http://model.local/v1', apiKey: 'k', model: 'glm-test' };

/** server 装配判定（纯函数）：是否注入 AI 任务解析 taskParser */
describe('hasChatRoute（server 装配：是否注入 taskParser）', () => {
  it('routes 含 chat 路由 → 注入（true）', () => {
    const routes: RouteConfig[] = [
      { callType: 'code', primary: spec },
      { callType: 'chat', primary: spec },
    ];
    expect(hasChatRoute(routes)).toBe(true);
  });

  it('routes 无 chat 路由（无模型集成模式）→ 不注入（false），保 400「未启用智能生成（未配置模型）」', () => {
    const routes: RouteConfig[] = [
      { callType: 'code', primary: spec },
      { callType: 'review', primary: spec },
    ];
    expect(hasChatRoute(routes)).toBe(false);
  });

  it('routes 为空数组或未配置 → false', () => {
    expect(hasChatRoute([])).toBe(false);
    expect(hasChatRoute(undefined)).toBe(false);
  });
});

/** startConsoleServer 装配接线（不监听端口）：handler 依赖是否传全 */
describe('startConsoleServer 装配接线（node:http 打桩，不 listen）', () => {
  it('GET /api/messages 返回 200（消息中心已启用，防回归 2026-09-06：messages 漏传曾致恒 400「未启用消息中心」）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-server-assembly-'));
    try {
      // 存储企业化 Task 7：装配缺省即 sqlite（Sql 全家），--store/file 分支已退役
      await startConsoleServer({ dataDir: root });
      const handler = httpMock.handler;
      expect(handler).toBeTypeOf('function');

      const res = {
        headersSent: false,
        status: 0,
        body: '',
        writeHead(status: number) {
          res.status = status;
        },
        end(body: string) {
          res.body = body;
        },
      };
      const req = {
        method: 'GET',
        url: '/api/messages',
        headers: {} as Record<string, string>,
        on(event: string, cb: () => void) {
          if (event === 'end') cb();
        },
      };
      // server 回调内是 fire-and-forget 的 async IIFE：await 其同步段后轮询等待响应落定
      // （消息存储读文件走线程池 macrotask，单次微任务 flush 可能早于响应，故轮询至 writeHead 被调）
      await handler!(req, res);
      for (let i = 0; i < 1000 && res.status === 0; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      expect(res.status).toBe(200);
      const json = JSON.parse(res.body) as { messages: unknown[]; unread: number };
      expect(json.messages).toEqual([]);
      expect(json.unread).toBe(0);
    } finally {
      // 装配已 await（ensureSchema 完成后才返回）：sqlite 库/seed 落库均为 db 内写入，
      // 直接重试 rm 清理（卸链后的写入落在已 unlink 的 inode，不会重建目录）
      for (let i = 0; i < 10; i++) {
        try {
          await rm(root, { recursive: true, force: true });
          break;
        } catch {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }
  });

  it('配置 runtime 时启动即建 workspaceRoot/sessionsRoot 根目录（2026-09-10 用户反馈：此前首单分派前两根不存在）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-server-assembly-'));
    try {
      const workspaceRoot = join(root, 'data', 'workspace'); // 故意多层不存在：验证 recursive 兜底
      const sessionsRoot = join(root, 'data', 'sessions');
      await startConsoleServer({
        dataDir: root,
        runtime: { profiles: [], routes: [], workspaceRoot, sessionsRoot } satisfies ConsoleRuntimeConfig,
      });
      expect((await stat(workspaceRoot)).isDirectory()).toBe(true);
      expect((await stat(sessionsRoot)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('strictMode fail-safe（2026-09-11 复盘批）：未配 auth/bindHost 拒绝启动（listen 前 throw，端口不占）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-server-strict-'));
    try {
      await expect(startConsoleServer({
        dataDir: root,
        runtime: { profiles: [], routes: [], workspaceRoot: join(root, 'w'), sessionsRoot: join(root, 's'), strictMode: true } satisfies ConsoleRuntimeConfig,
      })).rejects.toThrow(/strictMode 已启用但缺少安全配置/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('strictMode fail-safe：auth + bindHost 齐备时正常启动（不拦）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-server-strict-ok-'));
    try {
      await startConsoleServer({
        dataDir: root,
        runtime: {
          profiles: [], routes: [], workspaceRoot: join(root, 'w'), sessionsRoot: join(root, 's'),
          strictMode: true, auth: { tokens: [{ name: '管理员', token: 'ddw-x' }] }, bindHost: '127.0.0.1',
        } satisfies ConsoleRuntimeConfig,
      });
      expect(httpMock.handler).toBeTypeOf('function');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('员工模型 apiKey 存量密文化迁移（2026-09-11 复盘批）：主密钥在场启动即把库里明文翻写 enc:v1:', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-server-empenc-'));
    try {
      vi.stubEnv('DDW_CRED_KEY', 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=');
      // 种子：直接写同一 sqlite 库——模拟存量明文 apiKey（encryptEmployeeModelKey 之前的入库形态）
      const driver = new SqliteDriver(join(root, 'ddw.sqlite'));
      await driver.ensureSchema();
      await new SqlEmployeeStore(driver).upsert({
        id: 'emp-enc', name: '存量工', roles: ['后端'], capabilities: [], enabled: true, createdAt: Date.now(),
        model: { baseUrl: 'http://x/v1', apiKey: 'sk-plain-legacy', model: 'glm-x' },
      });
      await driver.close();

      await startConsoleServer({ dataDir: root }); // 启动即迁移（装配 await，返回时已完成）

      const check = new SqliteDriver(join(root, 'ddw.sqlite'));
      try {
        const rows = await check.all<{ doc: string }>('SELECT doc FROM ddw_employees WHERE id = ?', ['emp-enc']);
        const doc = JSON.parse(rows[0]!.doc) as { model?: { apiKey: string } };
        expect(doc.model!.apiKey).toMatch(/^enc:v1:/);
        expect(doc.model!.apiKey).not.toContain('sk-plain-legacy');
      } finally {
        await check.close();
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('启动孤儿扫描（2026-09-11 P0 韧性批）：DB 残留 claimed/running 标 failed「进程重启中断」，可续跑/重置', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-server-orphan-'));
    try {
      // 种子：直接写 server 用的同一 sqlite 库（<dataDir>/ddw.sqlite）——模拟上一进程崩溃残留
      // （inFlight 内存态已丢、worker 随主进程死，执行永无回写）
      const driver = new SqliteDriver(join(root, 'ddw.sqlite'));
      await driver.ensureSchema();
      const seed = new SqlTaskStore(driver);
      const pkg = parseTaskPackage(
        'taskId: ORPHAN-1\ntitle: 崩溃残留\nrepo: { url: "http://gitlab.inner.bank/x.git", branch: main }\ntasks: [{ id: T-1, title: t, files: [src/x.js], requirement: r, acceptance: [a] }]',
      );
      await seed.add(pkg);
      await seed.claim('ORPHAN-1', 'emp-01');
      await seed.markRunning('ORPHAN-1');
      await driver.close();

      await startConsoleServer({ dataDir: root }); // 启动即扫（装配内 await，返回时已完成）

      const handler = httpMock.handler;
      expect(handler).toBeTypeOf('function');
      const res = {
        headersSent: false,
        status: 0,
        body: '',
        writeHead(status: number) {
          res.status = status;
        },
        end(body: string) {
          res.body = body;
        },
      };
      const req = {
        method: 'GET',
        url: '/api/tasks/ORPHAN-1',
        headers: {} as Record<string, string>,
        on(event: string, cb: () => void) {
          if (event === 'end') cb();
        },
      };
      await handler!(req, res);
      for (let i = 0; i < 1000 && res.status === 0; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      expect(res.status).toBe(200);
      const json = JSON.parse(res.body) as { status: string; result?: { reply?: string } };
      expect(json.status).toBe('failed');
      expect(json.result?.reply).toContain('进程重启中断');
    } finally {
      for (let i = 0; i < 10; i++) {
        try {
          await rm(root, { recursive: true, force: true });
          break;
        } catch {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }
  });
});
