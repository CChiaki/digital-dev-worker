import { startConsoleServer, installSignalHandlers } from './http/server.js';
import { loadRuntimeConfig, DEFAULT_STORAGE } from './team/runtime-config.js';
import { encryptSecret, generateMasterKey, MASTER_KEY_ENV } from './team/credentials.js';
import { issueToken, yamlLineFor, insertTokenLine } from './team/token-issue.js';
import { runDoctor } from './doctor.js';
import { runMigration } from './migrate.js';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * 控制台 CLI 入口：
 *   node dist/cli.js [--port 3100] [--data ./data] [--runtime <yaml>] [--exec-mode inproc|fork]
 *                    [--agent-module <agent 工厂模块路径>]   # 配合 --exec-mode fork：预设回复演示（P16）
 *   node dist/cli.js cred key                # 生成主密钥（注入试点机环境变量 DDW_CRED_KEY）
 *   node dist/cli.js cred enc <明文>          # 产出 enc:v1: 密文（粘贴进 runtime yaml 的 apiKey）
 *   node dist/cli.js token <name> [--yaml <path>]   # 签发 API 访问令牌（--yaml 顺带写入 auth 段）
 *   node dist/cli.js doctor [--data …] [--runtime <yaml>] [--probe]   # 交付巡检（P11）
 *   node dist/cli.js migrate [--to sqlite|mysql] [--data <dir>] [--runtime <yaml>]   # 存量数据一次性迁移（存储企业化 Task 8）
 * 数据目录默认 `<包根>/data`；存储（存储企业化 Task 7）由 --runtime yaml 的 storage 段配置
 * （缺省 sqlite，`<data>/ddw.sqlite`；mysql 需配 host/user/database），--store 参数已退役。
 * --runtime 提供即进入一体化模式（数字员工名册 + 模型路由，调度器自动分派）。
 * 启动服务须由用户命令触发，此处仅提供入口。
 */
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- 子命令（输出后退出，不起服务不占端口） ----
const sub = argv[0];
if (sub === 'cred') {
  const op = argv[1];
  if (op === 'key') {
    console.log(generateMasterKey());
    console.error(`\n# 用法：将上面密钥注入试点机环境变量 ${MASTER_KEY_ENV}，再用 "cred enc" 加密 apiKey`, );
    process.exitCode = 0;
  } else if (op === 'enc') {
    const plain = argv[2];
    if (!plain) {
      console.error('用法：cred enc <明文>   （主密钥从环境变量 DDW_CRED_KEY 读取）');
      process.exitCode = 1;
    } else {
      const masterKey = process.env[MASTER_KEY_ENV];
      if (!masterKey) {
        console.error(`错误：环境变量 ${MASTER_KEY_ENV} 未设置。先用 "cred key" 生成并注入。`);
        process.exitCode = 1;
      } else {
        console.log(encryptSecret(plain, masterKey));
        process.exitCode = 0;
      }
    }
  } else {
    console.error('用法：cred key | cred enc <明文>');
    process.exitCode = 1;
  }
} else if (sub === 'token') {
  // ---- API 访问令牌签发（2026-09-11 P2 产品批补充）：生成 ddw- 随机令牌 + enc:v1 密文 yaml 行，
  //      --yaml <path> 顺带写入 auth.tokens 段（重启生效）。背景：手工维护 token 时管理员容易
  //      把 yaml 里的密文当明文分发，使用者录入恒 401——签发命令明文/密文一并给出不再混淆 ----
  const name = argv[1];
  if (!name || name.startsWith('--')) {
    console.error('用法：token <操作者名> [--yaml <runtime yaml 路径>]   （主密钥从环境变量 DDW_CRED_KEY 读取）');
    process.exitCode = 1;
  } else {
    process.exitCode = 0; // 写 yaml 失败分支覆盖为 1
    const masterKey = process.env[MASTER_KEY_ENV];
    const issued = issueToken(name, masterKey);
    const line = yamlLineFor(issued);
    console.log(`已签发访问令牌（操作者：${name}）`);
    console.log(`\n明文令牌（分发给使用者，粘贴进网页「访问鉴权」弹窗；不是配置文件里的 enc:v1 密文）:\n  ${issued.token}`);
    if (issued.tokenEnc) {
      console.log(`\nyaml 行（密文落盘防配置文件泄漏；明文可随时从密文用主密钥解出，不存丢失）:\n  ${line}`);
    } else {
      console.log(`\nyaml 行（DDW_CRED_KEY 未设置——明文落盘，建议先 cred key 配主密钥）:\n  ${line}`);
    }
    const yamlPath = arg('--yaml');
    if (yamlPath) {
      const abs = resolve(yamlPath);
      try {
        const updated = insertTokenLine(readFileSync(abs, 'utf8'), line);
        writeFileSync(abs, updated);
        console.log(`\n已写入 ${abs}（auth.tokens 段），重启服务生效：DDW_CRED_KEY=... pm2 restart <进程名> --update-env`);
      } catch (e) {
        console.error(`写入 yaml 失败（${e instanceof Error ? e.message : e}）——请把上面 yaml 行手工粘进 auth.tokens 段`);
        process.exitCode = 1;
      }
    } else {
      console.log('\n未指定 --yaml：请把上面 yaml 行手工粘进 auth.tokens 段，重启服务生效');
    }
  }
} else if (sub === 'migrate') {
  // ---- 存量数据一次性迁移（存储企业化 Task 8）：源 = 旧 sqlite task/event + 5 个 JSON（只读不动），
  // 目标 = --to（缺省 sqlite）；mysql 目标经 --runtime yaml storage 段。成功写 migrated-<driver>.marker。 ----
  const to = arg('--to');
  if (to !== undefined && !['sqlite', 'mysql'].includes(to)) {
    console.error(`错误：--to 必须是 sqlite/mysql 之一，得到 ${to}`);
    process.exitCode = 1;
  } else {
    try {
      const summary = await runMigration({
        dataDir: resolve(arg('--data') ?? join(pkgRoot, 'data')),
        to: to as 'sqlite' | 'mysql' | undefined,
        runtimePath: arg('--runtime') ? resolve(arg('--runtime')!) : undefined,
      });
      console.log(`迁移完成（目标 ${summary.target}）：
  任务 ${summary.tasks} 条 / 事件 ${summary.events} 条 / 员工 ${summary.employees} 名 /
  Skill 分类 ${summary.skillCategories} 个 / Skill ${summary.skills} 条 / 能力 ${summary.capabilities} 项 /
  消息 ${summary.messages} 条 / 通知渠道 ${summary.channels} 个`);
      if (summary.skipped.length > 0) {
        console.log(`跳过源（缺文件/缺表/残行）：${summary.skipped.join('；')}`);
      }
      console.log(`标记文件：${summary.markerPath}（源文件一律未动）`);
      process.exitCode = 0;
    } catch (e) {
      console.error(`迁移失败：${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  }
} else if (sub === 'doctor') {
  const ok = await runDoctor({
    dataDir: resolve(arg('--data') ?? join(pkgRoot, 'data')),
    runtimePath: arg('--runtime') ? resolve(arg('--runtime')!) : undefined,
    probe: argv.includes('--probe'),
  });
  process.exitCode = ok ? 0 : 1;
} else {
  // ---- 默认：启动控制台服务 ----
  // --store 退役（存储企业化 Task 7）：存储实现改由 runtime yaml 的 storage 段配置
  // argv.includes 直判（T7 评审 P3）：--store 为尾参（无值）时 arg() 返回 undefined 会绕过退役检查
  if (argv.includes('--store')) {
    console.error('错误：--store 已退役：存储配置改用 runtime yaml 的 storage 段');
    process.exit(1);
  }
  const port = Number(arg('--port') ?? 3100);
  const dataDir = arg('--data') ?? join(pkgRoot, 'data');

  // --runtime：一体化模式（解析/解密错误直接退出，错误信息可读）
  const runtimeArg = arg('--runtime');
  const runtime = runtimeArg ? loadRuntimeConfig(resolve(runtimeArg)) : undefined;
  // 存储配置（存储企业化 Task 7）：yaml storage 段；无 --runtime / 段缺省 = sqlite
  const storage = runtime?.storage ?? DEFAULT_STORAGE;

  // --exec-mode（P13）：inproc 单进程（默认）| fork 每任务独立子进程（崩溃隔离）；显式参数覆盖 yaml
  const execModeArg = arg('--exec-mode');
  if (execModeArg !== undefined && !['inproc', 'fork'].includes(execModeArg)) {
    console.error(`错误：--exec-mode 必须是 inproc/fork 之一，得到 ${execModeArg}`);
    process.exitCode = 1;
  } else {
    const execMode = execModeArg as 'inproc' | 'fork' | undefined;
    // --agent-module（P16 演示通道）：fork worker 动态 import 的 agent 工厂模块（如 demo/faux-agent.mjs，
    // 配合 --exec-mode fork 实现 --mock 预设回复演示）；生产不传走 pi 直连
    const agentModuleArg = arg('--agent-module');
    const server = await startConsoleServer({
      dataDir, port,
      ...(runtime ? {
        runtime: {
          ...runtime,
          ...(execMode ? { execMode } : {}),
          ...(agentModuleArg ? { agentModulePath: resolve(agentModuleArg) } : {}),
          workspaceRoot: resolve(runtime.workspaceRoot),
          sessionsRoot: resolve(runtime.sessionsRoot),
        },
      } : {}),
    });
    server.on('listening', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      console.log(`[console-api] listening on http://localhost:${actual}  (storage: ${storage.driver}, data: ${dataDir})`);
      console.log('[console-api] SSE 直播: /api/events/stream');
      if (runtime) {
        console.log(`[console-api] 一体化模式: ${runtime.profiles.length} 名数字员工, tick ${runtime.tickIntervalMs ?? 5000}ms（--runtime ${runtimeArg}）`);
        console.log(`[console-api] 执行模式: ${execMode ?? runtime.execMode ?? 'inproc'}${agentModuleArg ? `（agent 工厂: ${agentModuleArg}，预设回复演示）` : ''}`);
      }
    });
    // 优雅停机（2026-09-11 P1 治理批）：SIGTERM/SIGINT → 停接入/断 SSE/停定时器/关连接池再退出；
    // pm2 restart / systemd stop / 手工 kill 均走此路径，硬退上限 30s
    installSignalHandlers(server);
  }
}
