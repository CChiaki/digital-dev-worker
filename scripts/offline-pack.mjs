#!/usr/bin/env node
/**
 * 离线交付打包（P11-T3）——在有网开发机执行，产出可拷贝到银行内网试点机的离线包：
 *
 *   node scripts/offline-pack.mjs            # 产出 dist-offline/ddw-offline-<date>.tar.gz
 *
 * 包内容：
 *   repo/       仓库源码（git archive HEAD，不含 node_modules / data / 离线包自身）
 *   pnpm-store/ pnpm 依赖仓库（pnpm install --offline 直接消费，锁文件钉死版本）
 *   install.sh  试点机安装脚本（解包后执行）
 *   OFFLINE.md  安装与验收步骤
 *
 * 注意：本脚本只在有网开发机执行；交付前用 scripts/rehearsal.mjs 做一键预演（打包→模拟安装→巡检）。
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意用 fileURLToPath：中文路径下 URL.pathname 是百分号编码的假路径（P15 演练实测踩坑）
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'dist-offline');
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: repoRoot, stdio: 'inherit', ...opts });

console.log('[offline-pack] 1/5 同步 lockfile 全量依赖进 store（pnpm fetch，有网机动作）');
// store 可能被清理/缺包（演练实测：typescript-5.5.4 缺失），fetch 确保 lockfile ↔ store 一致；
// CI=true 跳过非 TTY 下的交互确认（fetch 会询问是否清 modules 目录）
sh('pnpm fetch', { env: { ...process.env, CI: 'true' } });

console.log('[offline-pack] 2/5 确定 pnpm store 位置');
const storePath = execSync('pnpm store path', { cwd: repoRoot, encoding: 'utf8' }).trim();
console.log(`  store: ${storePath}`);

console.log('[offline-pack] 3/5 组装打包目录');
const work = mkdtempSync(join(tmpdir(), 'ddw-offline-'));
const stage = join(work, 'stage');
mkdirSync(join(stage, 'repo'), { recursive: true });
mkdirSync(join(stage, 'pnpm-store'), { recursive: true });

// 仓库源码：git archive（自动排除 .gitignore 内容，含 node_modules/data）
sh(`git archive HEAD | tar -x -C ${JSON.stringify(stage + '/repo')}`);

// pnpm store（硬链接在 tar 中展开为普通文件；体积=依赖全量，内网一次性拷贝可接受）。
// 关键：保留版本子目录（v11）——pnpm 对 --store-dir <x> 实际读 <x>/v11/，
// 平铺到 pnpm-store/ 根等于空 store（演练实测：离线安装报 NO_OFFLINE_TARBALL）
const storeVersion = basename(storePath); // 'v11'
sh(
  `tar -cf - -C ${JSON.stringify(dirname(storePath))} ${JSON.stringify(storeVersion)} ` +
  `| tar -xf - -C ${JSON.stringify(join(stage, 'pnpm-store'))}`,
);

// 安装脚本 + 说明
cpSync(join(repoRoot, 'scripts', 'offline-install.sh'), join(stage, 'install.sh'));
writeFileSync(join(stage, 'OFFLINE.md'), offlineMd());

console.log('[offline-pack] 4/5 打 tar 包并校验产物');
mkdirSync(outDir, { recursive: true });
const date = new Date().toISOString().slice(0, 10);
const outFile = join(outDir, `ddw-offline-${date}.tar.gz`);
sh(`tar -czf ${JSON.stringify(outFile)} -C ${JSON.stringify(stage)} .`);
verifyPackage(outFile);

console.log(`[offline-pack] 5/5 清理临时目录（包体积 ${(statSync(outFile).size / 1024 / 1024).toFixed(1)} MB）`);
rmSync(work, { recursive: true, force: true });

console.log(`\n✅ 离线包已产出: ${outFile}`);
console.log('   拷贝到试点机后：tar -xzf <包> -C ddw && cd ddw && bash install.sh');
console.log('   （交付前预演：node scripts/rehearsal.mjs —— 打包→模拟安装→巡检一键走通）');
console.log('   （打包动作请在有网开发机执行；试点机全程离线）');

/** 包产物校验（P15-T1）：包损坏在开发机发现，不上试点机——关键条目逐个抽查 + store 条目计数。
 *  不拉全量清单（万级条目会超 execSync maxBuffer，演练实测踩坑）。 */
function verifyPackage(outFile) {
  const required = ['./install.sh', './OFFLINE.md', './repo/package.json', './repo/pnpm-workspace.yaml', './repo/pnpm-lock.yaml', './repo/scripts/offline-install.sh'];
  const missing = required.filter((f) => {
    try {
      execSync(`tar -tzf ${JSON.stringify(outFile)} ${JSON.stringify(f)}`, { stdio: 'pipe' });
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) throw new Error(`离线包缺关键条目: ${missing.join(', ')}`);
  const storeEntries = parseInt(
    execSync(`tar -tzf ${JSON.stringify(outFile)} | grep -c '^\\./pnpm-store/'`, { encoding: 'utf8' }).trim(),
    10,
  );
  if (storeEntries < 100) throw new Error(`pnpm-store 条目过少（${storeEntries}），依赖仓库疑似不完整`);
  console.log(`  ✓ 产物校验通过（关键条目齐全 + pnpm-store ${storeEntries} 条）`);
}

function offlineMd() {
  return `# 离线交付包 · 安装与验收

## 前置条件（试点机）
- Node.js ≥ 20.5（node:sqlite 内置驱动；推荐 22 LTS）
- pnpm ≥ 9（若试点机无 pnpm：npm i -g pnpm 需在有网机下载好 tgz 带入）
- bash

## 安装（全程离线）
\`\`\`bash
tar -xzf ddw-offline-<date>.tar.gz -C ddw
cd ddw
bash install.sh
\`\`\`

install.sh 做四件事：
0. Node 版本前置检查（< 20.5 首错即拦）
1. pnpm install --offline --frozen-lockfile --store-dir ./pnpm-store（依赖全部来自随包 store，不出网）
2. pnpm -r test（冒烟：全量用例全绿即安装成功，数量见总账）
3. 提示下一步：凭据配置 + doctor 巡检

## 凭据配置（密文落盘，主密钥不落盘）
\`\`\`bash
export DDW_CRED_KEY=$(node packages/console-api/src/cli.ts cred key)   # 生成一次，注入 systemd/启动环境
node packages/console-api/src/cli.ts cred enc '<模型集群真实apiKey>'     # 输出 enc:v1:... 粘贴进 yaml
\`\`\`
详见 README「试点机离线交付」。

## 巡检
\`\`\`bash
node packages/console-api/src/cli.ts doctor --data ./data --runtime examples/console-runtime.example.yaml --probe
\`\`\`
全部 ✓ 后即可启动（命令见 README「控制台启动」）。
`;
}
