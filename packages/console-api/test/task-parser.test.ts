import { describe, expect, it, vi, afterEach } from 'vitest';
import { ModelGateway, DEFAULT_STREAM } from '@ddw/runtime';
import type { ModelSpec, RouteConfig } from '@ddw/runtime';
import { parseTaskDescription, buildTaskParseSystemPrompt, buildYamlFixSystemPrompt, type CapabilityBrief, type McpToolBrief } from '../src/team/task-parser.js';

const spec: ModelSpec = { name: 'glm-test', baseUrl: 'http://model.local/v1', apiKey: 'k', model: 'glm-test' };

/** 构造测试 gateway，并把模型回复注入缺省流（照抄 runtime gateway.test.ts 的 DEFAULT_STREAM spy 手法）；
 *  回复可为 string（简单 mock）或 pi AssistantMessageEventStream 形态（result() → AssistantMessage，生产路径） */
const gwWith = (reply: () => Promise<unknown>): ModelGateway => {
  const routes: RouteConfig[] = [{ callType: 'chat', primary: spec }];
  vi.spyOn(DEFAULT_STREAM, 'openai-completions').mockImplementation(reply as never);
  return new ModelGateway(routes);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseTaskDescription（AI 解析任务包，2026-09-06）', () => {
  const goodYaml = [
    'taskId: feat-login', 'title: 登录功能开发',
    'repo: { url: "http://localhost:3000/demo/web-app.git", branch: develop }',
    'plan:', '  - id: t1', '    title: 开发', '    detail: 实现 POST /api/login',
  ].join('\n');

  it('模型返回 yaml 代码块 → 提取并过 parseTaskPackage 校验后原样返回', async () => {
    const gateway = gwWith(async () => '以下是生成结果：\n```yaml\n' + goodYaml + '\n```');
    const yaml = await parseTaskDescription(gateway, '做一个登录功能', async () => ['dev', 'test']);
    expect(yaml).toContain('taskId: feat-login');
  });

  it('模型输出非法任务包 → 抛可读错误（含模型原始输出首行）', async () => {
    const gateway = gwWith(async () => '```yaml\ntaskId: [broken\n```');
    await expect(parseTaskDescription(gateway, 'x', async () => ['dev']))
      .rejects.toThrow(/智能生成失败/);
  });

  it('生产路径：StreamFn 返回 AssistantMessageEventStream（result() → AssistantMessage）→ 取 text 块解析', async () => {
    const gateway = gwWith(async () => ({
      result: async () => ({ content: [{ type: 'text', text: '```yaml\n' + goodYaml + '\n```' }] }),
    }));
    const yaml = await parseTaskDescription(gateway, '做一个登录功能', async () => ['dev']);
    expect(yaml).toContain('taskId: feat-login');
  });

  it('模型返回 yaml 引用未注册 kind → 抛可读错误', async () => {
    const withKind = goodYaml + '\n  - id: t2\n    kind: nope\n    title: x\n    detail: d';
    const gateway = gwWith(async () => '```yaml\n' + withKind + '\n```');
    await expect(parseTaskDescription(gateway, 'x', async () => ['dev']))
      .rejects.toThrow(/kind='nope' 未注册/);
  });

  it('系统提示词包含 schema 约束与已启用 kind 列表', () => {
    const s = buildTaskParseSystemPrompt(['dev', 'test', 'commit']);
    expect(s).toContain('dev');
    expect(s).toContain('yaml');
    expect(s).toContain('kind');
  });

  it('系统提示词包含格式铁律（每键独占一行、特殊值加引号，2026-09-06 实战坏例）', () => {
    const s = buildTaskParseSystemPrompt(['dev']);
    expect(s).toContain('独占一行');
    expect(s).toContain('引号');
  });

  it('verify 规则（2026-09-10 实战坏例）：commit 节点禁用本地 git log 校验（API 提交不落本地历史）', () => {
    const s = buildTaskParseSystemPrompt(['dev', 'commit']);
    expect(s).toContain('verify 铁律');
    expect(s).toContain('禁止用 git log');
  });

  it('能力矩阵注入（2026-09-10）：caps + MCP 工具清单进提示词，且带「优先 MCP 工具」指令', () => {
    const caps: CapabilityBrief[] = [
      { kind: 'devops', name: '发布部署', description: '按任务描述部署', builtin: ['bash', 'files'], mcp: ['jenkins'] },
    ];
    const mcpTools: McpToolBrief[] = [{ server: 'jenkins', tools: ['mcp_jenkins_jenkins_trigger_build'] }];
    const s = buildTaskParseSystemPrompt(['dev', 'devops'], caps, mcpTools);
    expect(s).toContain('能力矩阵');
    expect(s).toContain('devops「发布部署」');
    expect(s).toContain('mcp_jenkins_jenkins_trigger_build');
    expect(s).toContain('绝不写 REST API');
  });

  it('能力矩阵不传（缺省）→ 提示词不含矩阵段（旧调用零回归）', () => {
    const s = buildTaskParseSystemPrompt(['dev']);
    expect(s).not.toContain('能力矩阵');
  });

  it('parseTaskDescription 传 capabilityCtx → 提示词含 MCP 工具名（捕获 systemPrompt 断言）', async () => {
    let capturedSystem = '';
    vi.spyOn(DEFAULT_STREAM, 'openai-completions').mockImplementation((async (_m: unknown, ctx: { systemPrompt?: string }) => {
      capturedSystem = ctx?.systemPrompt ?? '';
      return '```yaml\n' + goodYaml + '\n```';
    }) as never);
    const gateway = new ModelGateway([{ callType: 'chat', primary: spec }]);
    await parseTaskDescription(gateway, '触发 help-doc 构建', async () => ['dev'], async () => ({
      caps: [{ kind: 'dev', name: '开发编码', mcp: [] }],
      mcpTools: [{ server: 'jenkins', tools: ['mcp_jenkins_jenkins_trigger_build'] }],
    }));
    expect(capturedSystem).toContain('mcp_jenkins_jenkins_trigger_build');
    expect(capturedSystem).toContain('绝不写 REST API');
  });

  it('修复提示词：约束只输出修正后 yaml 且重申铁律', () => {
    const s = buildYamlFixSystemPrompt();
    expect(s).toContain('修正');
    expect(s).toContain('独占一行');
  });
});

describe('parseTaskDescription 自愈重试（2026-09-06）：解析失败把错误回传模型修一次', () => {
  const goodYaml = [
    'taskId: feat-detail', 'title: 详情页开发',
    'repo: { url: "http://localhost:3000/demo/web-app.git", branch: develop }',
    'plan:', '  - id: t1', '    title: 提交改动', '    detail: "在 dev 分支提交（git commit -m \\"feat: 新增详情页\\")"',
  ].join('\n');
  // 实战坏例形态：一行写两个键（compact mapping）且值内含冒号引号 → Nested mappings 解析失败
  const badYaml = [
    'taskId: feat-detail', 'title: 详情页开发',
    'repo: { url: "http://localhost:3000/demo/web-app.git", branch: develop }',
    'plan:', '  - id: t1 title: 提交改动 detail: 在 dev 分支提交（git commit -m "feat: 新增详情页"）',
  ].join('\n');

  it('第一次解析失败 → 回传错误重试 → 第二次合法则成功且返回修正后 yaml', async () => {
    let calls = 0;
    const gateway = gwWith(async () => {
      calls += 1;
      return calls === 1 ? '```yaml\n' + badYaml + '\n```' : '```yaml\n' + goodYaml + '\n```';
    });
    const yaml = await parseTaskDescription(gateway, 'x', async () => ['dev']);
    expect(calls).toBe(2);
    expect(yaml).toBe(goodYaml);
  });

  it('第一次就合法 → 只调一次模型，不触发重试', async () => {
    let calls = 0;
    const gateway = gwWith(async () => {
      calls += 1;
      return '```yaml\n' + goodYaml + '\n```';
    });
    await parseTaskDescription(gateway, 'x', async () => ['dev']);
    expect(calls).toBe(1);
  });

  it('重试后仍非法 → 抛可读错误（含首次解析错误）', async () => {
    let calls = 0;
    const gateway = gwWith(async () => {
      calls += 1;
      return '```yaml\n' + badYaml + '\n```';
    });
    await expect(parseTaskDescription(gateway, 'x', async () => ['dev']))
      .rejects.toThrow(/智能生成失败/);
    expect(calls).toBe(2);
  });
});
