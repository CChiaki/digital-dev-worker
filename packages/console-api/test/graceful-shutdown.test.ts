import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { startConsoleServer, shutdownConsole } from '../src/http/server.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('优雅停机（2026-09-11 P1 治理批）', () => {
  it('shutdownConsole：断开 SSE 长连接、关监听、停定时器并关驱动（close 事件联动）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ddw-shutdown-'));
    const server = await startConsoleServer({ dataDir: dir, port: 0 });
    const port = (server.address() as AddressInfo).port;

    try {
      // 常规请求可达
      const res = await fetch(`http://127.0.0.1:${port}/api/tasks`);
      expect(res.ok).toBe(true);

      // SSE 长连接挂起（不主动断开——旧实现裸杀进程时该连接被硬掐）
      const sse = await fetch(`http://127.0.0.1:${port}/api/events/stream`);
      expect(sse.ok).toBe(true);
      const reader = sse.body!.getReader();

      await shutdownConsole(server, 5000);

      // SSE 连接被服务端主动断开（而非永挂）；已缓冲的心跳块先被读出，读到 done 为止；
      // undici 对服务端中途断开抛 UND_ERR_SOCKET——同样是「已断开」的证明
      const readUntilClosed = async (): Promise<boolean> => {
        try {
          for (;;) {
            const r = await Promise.race([
              reader.read(),
              new Promise<{ done: boolean }>((_, rej) => setTimeout(() => rej(new Error('SSE 连接未被断开')), 5000)),
            ]);
            if (r.done) return true;
          }
        } catch {
          return true;
        }
      };
      expect(await readUntilClosed()).toBe(true);

      // 监听已关：新请求连接被拒
      await expect(fetch(`http://127.0.0.1:${port}/api/tasks`)).rejects.toThrow();
      expect(server.listening).toBe(false);
    } finally {
      await shutdownConsole(server, 1000).catch(() => {}); // 幂等兜底清理
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('SIGTERM（子进程信号模拟）：cli 走优雅停机后以退出码 0 退出', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ddw-sigterm-'));
    // --port 0 = 随机空闲端口（不影响本机 3100）；无 --runtime = sqlite 缺省存储（tmp dataDir）
    const child = spawn(
      process.execPath,
      ['--import', './src/team/ts-register.mjs', './src/cli.ts', '--port', '0', '--data', dir],
      { cwd: pkgRoot },
    );
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stdout += c.toString(); });

    try {
      // 等 listening 日志（ts-register 现场转译，启动需数秒）
      const listening = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 40_000);
        const poll = (): void => {
          if (stdout.includes('listening on')) { clearTimeout(t); resolve(true); return; }
          setTimeout(poll, 200);
        };
        poll();
      });
      expect(await listening).toBe(true);

      child.kill('SIGTERM');
      // 退出码 0（优雅路径 process.exit(0)；未接信号时 Node 缺省 SIGTERM 退出码为 null + signal）
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      expect(exit.code).toBe(0);
      expect(stdout).toContain('优雅停机');
    } finally {
      child.kill('SIGKILL'); // 已退出时无害，兜底防孤儿进程
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
