import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoopBackend, BwrapBackend, DockerBackend } from '../src/workspace/sandbox.js';
import { ControlledBash } from '../src/workspace/bash.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ddw-sandbox-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SandboxBackend 三实现 argv 包装', () => {
  it('NoopBackend：原样返回', () => {
    const argv = ['node', 'test/a.js'];
    expect(new NoopBackend().wrap(argv)).toEqual(argv);
    expect(new NoopBackend().name).toBe('noop');
  });

  it('BwrapBackend：只读根 + 工作区可写 + 断网 + 封 HOME', () => {
    const b = new BwrapBackend({ workspace: dir });
    const wrapped = b.wrap(['node', 'test/a.js', '--x']);
    expect(wrapped.slice(0, 4)).toEqual(['bwrap', '--ro-bind', '/usr', '/usr']);
    expect(wrapped).toContain('--proc');
    expect(wrapped).toContain('/proc');
    expect(wrapped).toContain('--dev');
    expect(wrapped).toContain('/dev');
    // 工作区绑定
    expect(wrapped).toContain(dir);
    expect(wrapped).toContain('/workspace');
    expect(wrapped).toContain('--tmpfs');
    expect(wrapped).toContain('/tmp');
    // 默认断网 + pid 隔离
    expect(wrapped).toContain('--unshare-net');
    expect(wrapped).toContain('--unshare-pid');
    // 原命令完整保留在末尾
    expect(wrapped.slice(-3)).toEqual(['node', 'test/a.js', '--x']);
    expect(b.name).toBe('bwrap');
  });

  it('BwrapBackend net=true 时不加 --unshare-net', () => {
    const b = new BwrapBackend({ workspace: dir, net: true });
    expect(b.wrap(['ls'])).not.toContain('--unshare-net');
  });

  it('DockerBackend：docker exec --workdir', () => {
    const b = new DockerBackend({ container: 'ddw-task-123', workdir: '/workspace' });
    const wrapped = b.wrap(['git', 'status']);
    expect(wrapped).toEqual(['docker', 'exec', '--workdir', '/workspace', 'ddw-task-123', 'git', 'status']);
    expect(b.name).toBe('docker');
  });
});

describe('ControlledBash 注入 backend', () => {
  it('Noop 下真实执行不受影响（白名单逻辑针对原始命令）', async () => {
    await writeFile(join(dir, 'hello.txt'), 'hi', 'utf8');
    const bash = new ControlledBash({
      root: dir, whitelist: ['ls'], timeoutMs: 5000, backend: new NoopBackend(),
    });
    const r = await bash.exec('ls hello.txt');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('hello.txt');
  });

  it('白名单仍校验原始命令首 token（非沙箱内命令）', async () => {
    const bash = new ControlledBash({
      root: dir, whitelist: ['ls'], timeoutMs: 5000, backend: new DockerBackend({ container: 'c1' }),
    });
    // 非白名单原始命令仍被拒（校验的是 whoami，而非 docker/bwrap）
    const r = await bash.exec('whoami');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('白名单');
  });
});
