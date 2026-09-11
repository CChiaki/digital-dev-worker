#!/usr/bin/env node
/**
 * 一键演示（P16）——汇报现场一条命令起全套：
 *
 *   node scripts/demo.mjs            # 接真实模型集群（runtime yaml 的 baseUrl/key 需先配好）
 *   node scripts/demo.mjs --mock     # faux 预设回复（不依赖集群网络，汇报现场兜底通道）
 *   node scripts/demo.mjs --no-web   # 只起 API（前端已另起时）
 *
 * 做五件事：
 *   1. 起控制台 API（一体化模式：2 名 shadow 盯梢期员工 + 班组调度）
 *   2.（默认）起控制台前端（vite dev，/api 代理到 API）
 *   3. --mock 时 fork 执行模式注入 faux agent 工厂（节点申报→现场放行→汇报 预设序列）
 *   4. 预置固化演示任务包（班组依赖编排：T-1 后端 → T-2 前端联调）
 *   5. 打印分步演示指引与访问地址
 *
 * 监听端口（API 3100 / 前端 5173），请经授权后运行；Ctrl-C 一起退出并清理。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mock = process.argv.includes('--mock');
const noWeb = process.argv.includes('--no-web');
const apiPort = 3100;
const webPort = 5173;

const dataDir = mkdtempSync(join(tmpdir(), 'ddw-demo-data-'));
const children = [];

const banner = (t) => console.log(`\n──────── ${t} ────────`);

// 启动前端口检查（演练实测：EADDRINUSE 子进程崩掉，现场看不明白）
const occupied = async (port) => {
  try { await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(500) }); return true; } catch { return false; }
};
if (await occupied(apiPort)) {
  console.error(`✗ 端口 ${apiPort} 已被占用（上次 demo 可能没退干净）。处置：lsof -ti :${apiPort} | xargs kill`);
  process.exit(1);
}

// 1. 控制台 API（一体化模式；--mock = fork 执行模式 + faux agent 工厂）
const apiArgs = [
  '--import', './packages/console-api/src/team/ts-register.mjs',
  'packages/console-api/src/cli.ts',
  '--port', String(apiPort),
  '--data', dataDir,
  '--runtime', 'examples/console-runtime-demo.yaml',
  ...(mock ? ['--exec-mode', 'fork', '--agent-module', 'packages/console-api/demo/faux-agent.mjs'] : []),
];
children.push(spawn('node', apiArgs, { cwd: repoRoot, stdio: 'inherit' }));
console.log(`[demo] 控制台 API 启动中: http://localhost:${apiPort}（数据: ${dataDir}）`);

// 2. 控制台前端（pnpm exec vite 在包目录直跑：`pnpm --filter dev -- --port` 形式 v11 会吞参数，实测踩坑）
if (!noWeb) {
  children.push(spawn('pnpm', ['exec', 'vite', '--port', String(webPort), '--strictPort'], { cwd: join(repoRoot, 'apps', 'console'), stdio: 'inherit' }));
  console.log(`[demo] 控制台前端启动中: http://localhost:${webPort}（vite dev，/api → ${apiPort}）`);
}

// 3. 等 API 就绪后预置演示任务包×2（后端先行，前端依赖后端——班组依赖编排）
const demoYamls = ['task-backend.yaml', 'task-frontend.yaml']
  .map((f) => readFileSync(join(repoRoot, 'examples', 'demo', f), 'utf8'));
const presetTasks = async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const results = await Promise.all(demoYamls.map((yaml) =>
        fetch(`http://localhost:${apiPort}/api/tasks`, { method: 'POST', headers: { 'content-type': 'text/yaml' }, body: yaml }),
      ));
      if (results.every((r) => r.ok)) {
        // 发布态（2026-09-06）：创建默认 draft，发布后才可被数字员工接取/分派
        const taskIds = await Promise.all(results.map(async (r) => (await r.json()).taskId));
        await Promise.all(taskIds.map((taskId) =>
          fetch(`http://localhost:${apiPort}/api/tasks/${taskId}/publish`, { method: 'POST' }),
        ));
        banner('演示场景已预置（2 个任务包：后端 → 前端联调，依赖编排）'); return;
      }
    } catch { /* 未就绪重试 */ }
    if (Date.now() > deadline) { console.error('[demo] API 30s 未就绪，请手动在控制台粘任务包固化（examples/demo/ 下两份 yaml）'); return; }
    await new Promise((r) => setTimeout(r, 500));
  }
};
void presetTasks();

// 4. 分步演示指引
banner('演示指引（8 分钟，详见 docs/演示剧本.md）');
console.log(`
① 任务中心  http://localhost:${webPort}
   看「消息通知服务端接口」已固化 → 调度器按岗位自动分派给 小数（backend）
② 员工直播  看 小数 开始干活：思考/工具调用实时滚动（每一步都留痕）
③ 人工放行  小数完成编码自测后申报节点（shadow 盯梢级 → 阻塞等待）
   在「人工放行」页看到待审节点 → 现场点击【放行】→ 直播里员工继续
④ 班组编排  后端包 done 后，前端联调包（dependsOn）自动分派给 小智（frontend）
⑤ 审计台账  查看全程事件 + 「审计校验」按钮（hash 链 tamper-evident）
${mock ? '\n※ 当前 --mock 模式：员工回复为预设序列（演示不依赖模型集群）；接真实集群去掉 --mock 即可。\n' : ''}
退出：Ctrl-C（API/前端一起停；演示数据在 ${dataDir}，可留存审计）
`);

const cleanup = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
for (const c of children) c.on('exit', (code) => { if (code !== 0 && code !== null) console.error(`[demo] 子进程退出 code=${code}`); });
