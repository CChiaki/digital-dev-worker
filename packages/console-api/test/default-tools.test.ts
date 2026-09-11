import { describe, it, expect } from 'vitest';
import { defaultToolsFor } from '../src/team/default-tools.js';

describe('defaultToolsFor builtin/mcp 分档（能力注册表工具集，2026-09-05）', () => {
  const forge = { provider: 'gitea' as const, baseUrl: 'http://localhost:3000', token: 'pat-x' };
  const deployCfg = { envs: [{ name: 'test', artifactDir: '/tmp/x' }] };

  it('缺省（不传 builtin/mcp）行为零回归：bash+files+forge（配了 forge 时），无 deploy 工具', () => {
    const tools = defaultToolsFor('/tmp/ws-x', { forge });
    const names = tools.list().map((t) => t.name);
    expect(names).toContain('run_cmd'); // 受控 bash 工具注册名（createBashTool）
    expect(names.some((n) => n.startsWith('gitlab_') || n.startsWith('gitea_'))).toBe(true);
    expect(names).not.toContain('deploy_to_env');
  });

  it('mcp:[] 时即便配了 forge 也不注入 forge 工具（dev/test 项最小工具集）', () => {
    const tools = defaultToolsFor('/tmp/ws-x', { forge, mcp: [] });
    expect(tools.list().map((t) => t.name).some((n) => n.startsWith('gitlab_') || n.startsWith('gitea_'))).toBe(false);
  });

  it('mcp:["deploy"] 注册 deploy 工具（须同时传 deploy 配置）', () => {
    const tools = defaultToolsFor('/tmp/ws-x', { deploy: deployCfg, mcp: ['deploy'] });
    expect(tools.list().map((t) => t.name)).toContain('deploy_to_env');
  });

  it('builtin:["files"] 不注册 bash（devops 项无裸 shell）', () => {
    const tools = defaultToolsFor('/tmp/ws-x', { builtin: ['files'] });
    expect(tools.list().map((t) => t.name)).not.toContain('run_cmd');
  });
});
