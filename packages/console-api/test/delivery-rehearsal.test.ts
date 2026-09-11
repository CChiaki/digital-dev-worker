import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * P15-T3 交付脚本防回归：语法检查（bash -n / node --check）+ 关键行为断言。
 * 只做静态校验——打包/安装/演练是需授权的重动作，测试不执行（不监听端口、不出网）。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = (p: string): string => readFileSync(join(ROOT, 'scripts', p), 'utf8');

const checkSyntax = (cmd: string, file: string): void => {
  execSync(cmd, { cwd: ROOT, stdio: 'pipe' });
};

describe('交付脚本防回归（P15）', () => {
  it('语法检查：shell/node 脚本全部可解析', () => {
    checkSyntax('bash -n scripts/offline-install.sh', 'offline-install.sh');
    checkSyntax('node --check scripts/offline-pack.mjs', 'offline-pack.mjs');
    checkSyntax('node --check scripts/rehearsal.mjs', 'rehearsal.mjs');
    expect(true).toBe(true);
  });

  it('install.sh：离线安装参数 + Node 前置检查 + 冒烟失败排查提示', () => {
    const s = script('offline-install.sh');
    // 包结构：repo/ 安装、store 在包根（兄弟目录）——演练实测踩坑：cd repo 后相对路径会指向不存在的 repo/pnpm-store
    expect(s).toContain('cd "$PKG_ROOT/repo"');
    expect(s).toContain('--store-dir "$PKG_ROOT/pnpm-store"');
    expect(s).toContain('pnpm -r test');
    // Node < 20.5 首错即拦（node:sqlite 依赖）
    expect(s).toContain('20.5');
    expect(s).toMatch(/process\.exit\(1\)/);
    // 冒烟失败给排查提示（试点机现场可自助定位）
    expect(s).toContain('排查提示');
  });

  it('offline-pack.mjs：打包后产物校验（关键条目 + pnpm-store 完整性 + store 版本层）', () => {
    const s = script('offline-pack.mjs');
    expect(s).toContain('tar -tzf');
    expect(s).toContain('离线包缺关键条目');
    // store 版本层（v11）：--store-dir <x> 实际读 <x>/v11/，平铺等于空 store（演练实测踩坑）
    expect(s).toContain('basename(storePath)');
    // lockfile 全量同步进 store：store 可能缺包（演练实测踩坑：typescript-5.5.4 缺失）
    expect(s).toContain('pnpm fetch');
    expect(s).toContain('rehearsal.mjs'); // 指向预演入口
  });

  it('rehearsal.mjs：一键串联 打包→解包→install→doctor，失败退出码 1', () => {
    const s = script('rehearsal.mjs');
    expect(s).toContain('offline-pack.mjs');
    expect(s).toContain('--skip-pack');
    expect(s).toContain("spawnSync('bash', ['install.sh']");
    expect(s).toContain("'doctor'");
    // doctor 裸 node 跑不了 TS 源码（.js 后缀导入），须带现场转译钩子（P13，演练实测踩坑）
    expect(s).toContain('ts-register.mjs');
    // 中文路径下 URL.pathname 是百分号编码假路径（演练实测踩坑）
    expect(s).toContain('fileURLToPath');
    expect(s).toContain('process.exit(1)');
    expect(s).toContain('--keep'); // 失败现场保留
  });

  it('systemd 单元样例：主密钥注入 + 数据目录硬化 + 失败重启', () => {
    const s = script('ddw-console.service');
    expect(s).toContain('EnvironmentFile=/etc/ddw/env');
    expect(s).toContain('DDW_CRED_KEY');
    expect(s).toContain('Restart=on-failure');
    expect(s).toContain('ReadWritePaths=');
    expect(s).toContain('--runtime');
  });

  it('一键 demo 脚本（P16）：mock 通道 + 演示数据齐备', () => {
    const s = script('demo.mjs');
    expect(s).toContain('--mock');
    expect(s).toContain('faux-agent.mjs'); // 预设回复 agent 工厂（fork agentModulePath 通道）
    expect(s).toContain('ts-register.mjs'); // 裸 node 直跑 TS 需现场转译钩子
    expect(s).toContain('fileURLToPath'); // 中文路径坑（P15 演练实测）
    // 演示数据存在且角色/依赖编排正确（静态断言，解析正确性由 parseTaskPackage 用例覆盖）
    const backend = readFileSync(join(ROOT, 'examples', 'demo', 'task-backend.yaml'), 'utf8');
    const frontend = readFileSync(join(ROOT, 'examples', 'demo', 'task-frontend.yaml'), 'utf8');
    expect(backend).toContain('role: backend');
    expect(backend).not.toContain('dependsOn');
    expect(frontend).toContain('role: frontend');
    expect(frontend).toContain('TASK-DEMO-001-BACKEND'); // 依赖后端包（班组编排演示点）
    // cli 支持 --agent-module 注入（mock 通道）
    expect(readFileSync(join(ROOT, 'packages', 'console-api', 'src', 'cli.ts'), 'utf8')).toContain('--agent-module');
    // faux 申报项必须是任务包清单里的合法项 id（演示实测踩坑：传 '编码自测' 被 isError 打回，shadow 闸门不触发）
    expect(readFileSync(join(ROOT, 'packages', 'console-api', 'demo', 'faux-agent.mjs'), 'utf8')).toContain("item: 'T-1'");
  });

  it('试点部署手册存在且覆盖全环节（巡检→启动→验收→排查→回滚）', () => {
    // 2026-09-11 文档开源化重整：手册归档到 docs/部署/
    const p = join(ROOT, 'docs', '部署', '试点部署手册.md');
    expect(existsSync(p)).toBe(true);
    const s = readFileSync(p, 'utf8');
    for (const section of ['install.sh', 'cred enc', 'doctor', 'systemd', '冒烟验收清单', '故障排查表', '回滚']) {
      expect(s).toContain(section);
    }
  });
});
