import { execFile } from 'node:child_process';
import { basename, dirname } from 'node:path';
import type { Tool, ToolResult } from '../types.js';
import { BashBlacklist } from '../security/bash-blacklist.js';
import type { BashExecResult, SandboxBackend } from './types.js';

/** 复用 P1 黑名单（S2 毕业）：rm -rf / sudo / 公网外呼等模式级拦截 */
const blacklist = new BashBlacklist();

/** 链式/注入元字符（P4「白名单 + 最小 shell」）：组合命令一律拒绝，逼模型分步执行 */
const METACHARS = /&&|\|\||;|\||\$\(|`|\n|>|</;

export interface ControlledBashOptions {
  /** 执行 cwd（任务工作区根） */
  root: string;
  /** 白名单（首 token；绝对路径执行器按 basename 校验） */
  whitelist: string[];
  /** 超时毫秒（缺省 60s；超时 SIGTERM 并报错） */
  timeoutMs?: number;
  /** 硬防线 argv 翻译层（缺省 Noop 直跑）；白名单校验始终针对原始命令首 token */
  backend?: SandboxBackend;
  /** 白名单未命中时的人工审批回调（2026-09-10 用户需求）：approved=true 本次放行执行；
   *  denied → 驳回错误返回给模型（换方案）。黑名单/组合命令元字符在进入回调前已硬拒——
   *  审批只兜「白名单没配但无害」的场景，安全底线不经人手。同命令重复审批的记忆由调用方实现。 */
  approval?: (cmd: string) => Promise<{ approved: boolean; comment?: string }>;
  /** 信任期放权（2026-09-11 盯梢三级重构）：true 时跳过白名单校验直接执行（trusted 级员工）。
   *  黑名单/组合命令元字符在前仍硬拒、超时照旧——放权只放白名单这一层，安全底线不参与。 */
  bypassWhitelist?: boolean;
}

/**
 * 引号感知 tokenizer：双/单引号内空格不断参（git commit -m "a b" 场景），
 * 引号不闭合报可读错误。不解释任何展开（$() 等已被元字符检查前置拒绝）。
 */
export function tokenize(cmd: string): string[] {
  const argv: string[] = [];
  let cur = '';
  let hasToken = false;
  let quote: '"' | "'" | undefined;
  const push = (): void => {
    if (hasToken) argv.push(cur);
    cur = '';
    hasToken = false;
  };
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      push();
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (quote) throw new Error(`命令解析失败：引号未闭合（${quote}）`);
  push();
  return argv;
}

/**
 * 受控 bash（spec 4.4 软防线 + 4.7 硬防线入口）：白名单 + 黑名单 + 注入拒绝 + 超时，
 * execFile 直跑 argv（不经 shell），cwd=root，backend.wrap 加壳后执行。
 * GIT_CEILING_DIRECTORIES=dirname(root)（2026-09-06 实战修复）：工作区不是 git 仓库时
 * 阻止 git 向上层穿透到宿主仓库（分支/提交全错的根因）——ceiling 取父目录：
 * 本身是仓库的工作区不受影响（cwd 先于 ceiling 判定），非仓库工作区向上一步即被截断。
 */
export class ControlledBash {
  private readonly root: string;
  private readonly whitelist: string[];
  private readonly timeoutMs: number;
  private readonly backend: SandboxBackend;
  private readonly approval?: ControlledBashOptions['approval'];
  private readonly bypassWhitelist: boolean;

  constructor(opts: ControlledBashOptions) {
    this.root = opts.root;
    this.whitelist = opts.whitelist;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.backend = opts.backend ?? { name: 'noop', wrap: (argv) => argv };
    this.approval = opts.approval;
    this.bypassWhitelist = opts.bypassWhitelist ?? false;
  }

  async exec(cmd: string): Promise<BashExecResult> {
    const trimmed = cmd.trim();
    if (!trimmed) return { ok: false, error: '空命令' };

    const blocked = blacklist.check({ toolName: 'run_cmd', args: { cmd: trimmed } });
    if (blocked) return { ok: false, error: blocked.reason };

    if (METACHARS.test(trimmed)) {
      return { ok: false, error: '复杂命令被拒绝：不支持 && ; | $() 反引号 重定向等组合，请分步执行' };
    }

    let argv: string[];
    try {
      argv = tokenize(trimmed);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const head = basename(argv[0]!);
    // 信任期放权（2026-09-11）：trusted 级员工跳过白名单整层（黑名单/元字符已在上方硬拒）；
    // 放权与审批互斥——bypass 时 approval 回调不可达，不构造
    if (!this.bypassWhitelist && !this.whitelist.includes(head)) {
      // 人工审批闸门（可选）：先挂起等裁决再决定执行；无回调保持原硬拒行为（零回归）
      if (this.approval) {
        const verdict = await this.approval(trimmed);
        if (!verdict.approved) {
          return { ok: false, error: `命令 ${head} 被人工驳回${verdict.comment ? `：${verdict.comment}` : ''}，请改用白名单命令或换实现方案` };
        }
      } else {
        return { ok: false, error: `命令 ${head} 不在白名单（${this.whitelist.join(' ')}），请联系管理员扩展` };
      }
    }

    const wrapped = this.backend.wrap(argv);
    return new Promise<BashExecResult>((resolve) => {
      execFile(
        wrapped[0]!,
        wrapped.slice(1),
        {
          cwd: this.root,
          timeout: this.timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(this.root) },
        },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
            if (e.killed || e.signal) {
              resolve({ ok: false, error: `命令超时（${this.timeoutMs}ms）已终止：${trimmed}` });
              return;
            }
            const code = typeof e.code === 'number' ? e.code : undefined;
            if (code !== undefined) {
              const first = stderr.split('\n').find((l) => l.trim()) ?? '';
              resolve({ ok: false, stdout, stderr, exitCode: code, error: `exit ${code}${first ? `: ${first.trim()}` : ''}` });
              return;
            }
            resolve({ ok: false, error: `执行失败（${head}）：${e.message}` });
            return;
          }
          resolve({ ok: true, stdout, stderr, exitCode: 0 });
        },
      );
    });
  }
}

/** run_cmd 工具包装：模型侧一个入口，执行/拦截全在 ControlledBash */
export function createBashTool(bash: ControlledBash): Tool {
  return {
    name: 'run_cmd',
    description: '在工作区根目录执行白名单命令（不走 shell，不支持管道/链式/重定向）',
    parameters: {
      cmd: { type: 'string', description: '命令行（如 git status、node test/a.test.js）', required: true },
    },
    async execute(args): Promise<ToolResult> {
      const cmd = typeof args.cmd === 'string' ? args.cmd : '';
      if (!cmd.trim()) return { ok: false, error: '缺少参数 cmd' };
      const r = await bash.exec(cmd);
      // 成功负载归 data（stdout/stderr/exitCode）；失败时若已真实执行过，附 data 供模型自查
      if (r.ok) return { ok: true, data: { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode } };
      return {
        ok: false,
        error: r.error,
        ...(r.exitCode !== undefined ? { data: { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode } } : {}),
      };
    },
  };
}
