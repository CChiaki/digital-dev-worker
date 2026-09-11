import { exec } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DeployTransport } from './transport.js';

const run = promisify(exec);

/** 产物发布环境配置（与 console-api DeployEnvConfig 同形；本包零依赖不反向 import） */
export interface ArtifactEnvConfig {
  name: string;
  artifactDir: string;
  restartCommand?: string;
  artifactPath?: string;
  host?: string;
  user?: string;
}

/**
 * 产物发布 transport（deploy 入参 env 收宽为 string——语义校验在工具层
 * createDeployTools（仅 test/staging），transport 层只做环境存在性检查）。
 * 可赋给 DeployTransport 使用（createDeployTools 入参）。
 */
export interface ArtifactTransport extends DeployTransport {
  deploy(req: { project: string; env: string; version: string }): Promise<{ id: string; status: string }>;
}

/**
 * 产物发布 transport（2026-09-05，本版范围：传产物 + 重启，不接 DevOps 平台）：
 * deploy() 同步完成"复制产物目录到目标 + 执行重启命令"，完成后即 done——
 * deploy_wait 首轮轮询即返回 ok；失败抛错 → 工具层 error → 任务项失败停链。
 * local：fs.cp + 本机 exec；配 host：ssh mkdir/scp -r/ssh exec。
 */
export function createArtifactTransport(deps: {
  envs: ArtifactEnvConfig[];
  workspaceDir: string;
  timeoutMs?: number;
}): ArtifactTransport {
  const timeoutMs = deps.timeoutMs ?? 10 * 60_000;
  const remote = (cfg: ArtifactEnvConfig, cmd: string): string =>
    `ssh ${cfg.user ? `${cfg.user}@` : ''}${cfg.host} "${cmd.replaceAll('"', '\\"')}"`;
  const scpTarget = (cfg: ArtifactEnvConfig): string =>
    `${cfg.user ? `${cfg.user}@` : ''}${cfg.host}:${cfg.artifactDir}`;

  return {
    async deploy({ project, env, version }) {
      const cfg = deps.envs.find((e) => e.name === env);
      if (!cfg) {
        throw new Error(`未配置发布环境: ${env}（可用: ${deps.envs.map((e) => e.name).join(', ') || '无'}）`);
      }
      const id = `deploy-${project}-${env}-${version}-${Date.now()}`;
      const src = join(deps.workspaceDir, cfg.artifactPath ?? 'dist');
      if (cfg.host) {
        await run(`ssh ${cfg.user ? `${cfg.user}@` : ''}${cfg.host} "mkdir -p ${cfg.artifactDir}"`, { timeout: timeoutMs });
        await run(`scp -r ${src} ${scpTarget(cfg)}`, { timeout: timeoutMs });
        if (cfg.restartCommand) await run(remote(cfg, cfg.restartCommand), { timeout: timeoutMs });
      } else {
        await mkdir(cfg.artifactDir, { recursive: true });
        await cp(src, cfg.artifactDir, { recursive: true });
        if (cfg.restartCommand) await run(cfg.restartCommand, { cwd: cfg.artifactDir, timeout: timeoutMs });
      }
      return { id, status: 'done' };
    },
    async getDeploy(id) {
      return { id, status: 'done' };
    },
  };
}
