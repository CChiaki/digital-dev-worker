#!/usr/bin/env node
/**
 * 交付预演（P15-T2）——在开发机一键走通交付链，消除"试点机现场首跑"风险：
 *
 *   node scripts/rehearsal.mjs                # 全流程：打包 → 解包 → 安装 → 冒烟 → 巡检
 *   node scripts/rehearsal.mjs --skip-pack    # 复用 dist-offline/ 已有离线包（省时）
 *
 * 步骤（与试点机动作一一对应）：
 *   1. 打包：offline-pack.mjs（--skip-pack 则复用 dist-offline/ddw-offline-*.tar.gz，取最新）
 *   2. 解包到临时目录 = 模拟试点机
 *   3. bash install.sh：离线安装 + pnpm -r test 冒烟（全程不出网）
 *   4. doctor 巡检（不带 --probe，不出网）：Node/数据目录/审计链/配置凭据/白名单
 *   5. 逐项报告；任一步失败退出码 1（--keep 保留现场目录供排查）
 *
 * 注意：本脚本会执行打包与安装动作，请经授权后运行；不监听任何端口。
 */
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意用 fileURLToPath：中文路径下 URL.pathname 是百分号编码的假路径（P15 演练实测踩坑）
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const skipPack = process.argv.includes('--skip-pack');
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: repoRoot, stdio: 'inherit', ...opts });

const report = [];
const record = (step, ok, detail) => {
  report.push({ step, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${step}${detail ? ` —— ${detail}` : ''}`);
};

let work;
try {
  // 1. 打包（或复用已有包）
  const outDir = join(repoRoot, 'dist-offline');
  let packFile;
  if (skipPack) {
    const packs = existsSync(outDir)
      ? readdirSync(outDir).filter((f) => /^ddw-offline-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f)).sort()
      : [];
    if (packs.length === 0) throw new Error('--skip-pack 但 dist-offline/ 无离线包，先跑一次全流程');
    packFile = join(outDir, packs.at(-1));
    console.log(`[rehearsal] 复用已有离线包: ${packs.at(-1)}`);
  } else {
    sh('node scripts/offline-pack.mjs');
    const packs = readdirSync(outDir).filter((f) => /^ddw-offline-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f)).sort();
    packFile = join(outDir, packs.at(-1));
  }
  record('1/4 打包', true, packFile);

  // 2. 解包 = 模拟试点机
  work = mkdtempSync(join(tmpdir(), 'ddw-rehearsal-'));
  sh(`tar -xzf ${JSON.stringify(packFile)} -C ${JSON.stringify(work)}`);
  record('2/4 解包（模拟试点机）', true, work);

  // 3. install.sh：离线安装 + 冒烟（内部含 Node 前置检查与失败排查提示）
  console.log('\n[rehearsal] 运行 install.sh（离线安装 + pnpm -r test 冒烟，全程不出网）…\n');
  const install = spawnSync('bash', ['install.sh'], { cwd: work, stdio: 'inherit' });
  if (install.status !== 0) throw new Error(`install.sh 退出码 ${install.status}（现场: ${keep ? work : '已清理，重跑加 --keep'}）`);
  record('3/4 安装 + 冒烟', true, 'pnpm install --offline + pnpm -r test 全绿');

  // 4. doctor 巡检（不带 --probe，不出网）。
  //    --import ts-register：本仓库 TS 源码（.js 后缀导入 + 参数属性）裸 node 跑不了，需现场转译钩子（P13）
  console.log('\n[rehearsal] 运行 doctor 巡检…\n');
  const doctor = spawnSync('node', ['--import', './packages/console-api/src/team/ts-register.mjs', 'packages/console-api/src/cli.ts', 'doctor', '--data', join(work, 'repo', 'data'), '--runtime', 'examples/console-runtime.example.yaml'], { cwd: join(work, 'repo'), stdio: 'inherit' });
  if (doctor.status !== 0) throw new Error('doctor 存在失败项（见上方 ✗ 行）');
  record('4/4 巡检', true, 'Node / 数据目录 / 审计链 / 配置凭据 / 白名单 全部 ✓');

  console.log('\n✅ 交付预演全部通过——试点机上按同样顺序执行即可（启动方式见 docs/试点部署手册.md）。');
  if (keep) console.log(`   现场保留: ${work}`);
} catch (e) {
  record('演练失败', false, e instanceof Error ? e.message : String(e));
  console.error(`\n❌ 预演未通过${keep && work ? `（现场保留: ${work}）` : '（重跑加 --keep 保留现场排查）'}`);
  if (!keep && work) rmSync(work, { recursive: true, force: true });
  // 报告落盘，便于交接排查
  try {
    const logPath = join(repoRoot, 'dist-offline', 'rehearsal-failed.log');
    mkdirSync(join(repoRoot, 'dist-offline'), { recursive: true });
    writeFileSync(logPath, JSON.stringify(report, null, 2));
    console.error(`   报告: ${logPath}`);
  } catch { /* 报告落盘失败不掩盖主错误 */ }
  process.exit(1);
}
