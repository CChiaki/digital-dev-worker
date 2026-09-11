import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactTransport } from '../src/artifact-transport.js';

const tmp = async (): Promise<string> => await mkdtemp(join(tmpdir(), 'deploy-'));

describe('createArtifactTransport（产物发布，2026-09-05）', () => {
  it('local：复制产物目录到目标 + 执行重启命令；未知环境报错可读', async () => {
    const dir = await tmp();
    try {
      const ws = join(dir, 'ws');
      const target = join(dir, 'opt', 'app');
      await mkdir(join(ws, 'dist'), { recursive: true });
      await writeFile(join(ws, 'dist', 'app.js'), 'console.log(1)');
      // 重启命令断言意图：restartCommand 真被执行——echo 写 flag 文件（跨平台稳定）
      const flag = join(dir, 'flag.txt');
      const transport = createArtifactTransport({
        envs: [{ name: 'test', artifactDir: target, restartCommand: `echo ok > ${JSON.stringify(flag)}` }],
        workspaceDir: ws,
      });
      const res = await transport.deploy({ project: 'web-app', env: 'test', version: 'abc123' });
      expect(res.status).toBe('done');
      expect(await readFile(join(target, 'app.js'), 'utf8')).toContain('console.log(1)');
      expect(await readFile(flag, 'utf8')).toContain('ok');
      await expect(transport.deploy({ project: 'p', env: 'prod', version: 'x' }))
        .rejects.toThrow(/未配置发布环境: prod/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('restartCommand 非零退出 → 抛错（工具层映射任务项失败）', async () => {
    const dir = await tmp();
    try {
      const ws = join(dir, 'ws');
      await mkdir(join(ws, 'dist'), { recursive: true });
      const transport = createArtifactTransport({
        envs: [{ name: 'test', artifactDir: join(dir, 't'), restartCommand: 'exit 3' }],
        workspaceDir: ws,
      });
      await expect(transport.deploy({ project: 'p', env: 'test', version: 'v' })).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
