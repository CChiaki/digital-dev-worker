#!/usr/bin/env bash
# 离线安装（P11-T3，P15-T1 加固）——在银行内网试点机执行（全程离线，不出网）：
#   0. 前置检查：Node ≥ 20.5（node:sqlite 内置驱动需要），首错即拦
#   1. pnpm install --offline（依赖全部来自随包 pnpm-store，锁文件钉死版本）
#   2. pnpm -r test 冒烟
#   3. 提示凭据配置与 doctor 巡检
set -euo pipefail
# 包结构：repo/（源码）+ pnpm-store/（依赖，repo 的兄弟目录）+ install.sh（本脚本在包根目录）
PKG_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$PKG_ROOT/repo"

step() { echo -e "\n[offline-install] $1"; }

step "0/4 前置检查：Node 版本"
node_ver=$(node -p 'process.versions.node' 2>/dev/null) || {
  echo "✗ 未找到 node：请先安装 Node.js ≥ 20.5（推荐 22 LTS）" >&2
  exit 1
}
node -e 'const [a,b]=[process.versions.node.split("."),["20","5","0"]];for(let i=0;i<3;i++){const x=+a[i]||0,y=+b[i];if(x!==y){if(x<y){console.error("✗ Node v"+process.versions.node+" 过低：node:sqlite 需 ≥ 20.5（推荐 22 LTS）");process.exit(1)}break}}' || exit 1
echo "  ✓ Node v${node_ver}"

step "1/3 pnpm install --offline（store: $PKG_ROOT/pnpm-store）"
t0=$(date +%s)
pnpm install --offline --frozen-lockfile --store-dir "$PKG_ROOT/pnpm-store"
echo "  ✓ 安装完成（$(( $(date +%s) - t0 ))s）"

step "2/3 冒烟：pnpm -r test（全程离线，不监听端口）"
t0=$(date +%s)
if ! pnpm -r test; then
  echo "" >&2
  echo "✗ 冒烟失败。排查提示：" >&2
  echo "  1. 依赖安装是否完整：重跑本脚本看第 1 步是否有报错" >&2
  echo "  2. pnpm-store 是否随包完整拷贝（包内 ./pnpm-store 目录）" >&2
  echo "  3. 磁盘空间：df -h .（安装 + 测试临时文件需要数百 MB）" >&2
  echo "  4. Node 版本：node -v（≥ 20.5，node:sqlite 依赖）" >&2
  exit 1
fi
echo "  ✓ 冒烟通过（$(( $(date +%s) - t0 ))s）"

step "3/3 安装完成。下一步："
echo "  1) 凭据配置：export DDW_CRED_KEY=\$(node packages/console-api/src/cli.ts cred key)"
echo "     然后 node packages/console-api/src/cli.ts cred enc '<真实apiKey>' 把密文填入 runtime yaml"
echo "  2) 巡检：node packages/console-api/src/cli.ts doctor --data ./data --runtime <yaml> --probe"
echo "  3) 启动：见 docs/试点部署手册.md（systemd 单元样例 scripts/ddw-console.service；须由运维按流程执行）"
