import { describe, expect, it } from 'vitest';
import {
  jsonSchemaToParamSpec,
  mcpToolToTool,
  McpHub,
  type McpClientLike,
  type McpServerConfig,
  type McpToolDef,
} from '../src/team/mcp-hub.js';

describe('jsonSchemaToParamSpec（MCP JSON Schema → ToolParamSpec）', () => {
  it('properties/required/description 转换；非必填无 required 键', () => {
    const spec = jsonSchemaToParamSpec({
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库路径' },
        limit: { type: 'number' },
      },
      required: ['repo'],
    });
    expect(spec['repo']).toEqual({ type: 'string', description: '仓库路径', required: true });
    expect(spec['limit']).toEqual({ type: 'number', description: '' });
    expect(spec['limit']?.required).toBeUndefined();
  });

  it('schema 缺省/properties 缺失 → 空对象（不炸）', () => {
    expect(jsonSchemaToParamSpec(undefined)).toEqual({});
    expect(jsonSchemaToParamSpec({ type: 'object' })).toEqual({});
  });
});

describe('mcpToolToTool（MCP 工具 → 本工程 Tool 契约）', () => {
  const def: McpToolDef = {
    name: 'create_issue',
    description: '创建 issue',
    inputSchema: { type: 'object', properties: { title: { type: 'string', description: '标题' } }, required: ['title'] },
  };

  it('工具名加 mcp_{server}_ 前缀；参数含 required 标注', () => {
    const client: McpClientLike = { listTools: async () => ({ tools: [] }), callTool: async () => ({}) };
    const tool = mcpToolToTool('gitlab', def, client);
    expect(tool.name).toBe('mcp_gitlab_create_issue');
    expect(tool.description).toBe('创建 issue');
    expect(tool.parameters['title']?.required).toBe(true);
  });

  it('execute：成功把 text content 拼为 data；isError 时 ok:false + error', async () => {
    let call: { name: string; arguments: Record<string, unknown> } | undefined;
    const okClient: McpClientLike = {
      listTools: async () => ({ tools: [] }),
      callTool: async (args) => {
        call = args;
        return { content: [{ type: 'text', text: 'created #1' }] };
      },
    };
    const tool = mcpToolToTool('gitlab', def, okClient);
    const res = await tool.execute({ title: 't' });
    expect(res.ok).toBe(true);
    expect(res.data).toBe('created #1');
    // 调远端用原始工具名（不带前缀）
    expect(call).toEqual({ name: 'create_issue', arguments: { title: 't' } });

    const errClient: McpClientLike = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    };
    const res2 = await mcpToolToTool('gitlab', def, errClient).execute({ title: 't' });
    expect(res2.ok).toBe(false);
    expect(res2.error).toBe('boom');
  });

  it('description 缺省 → 可读兜底文案', () => {
    const client: McpClientLike = { listTools: async () => ({ tools: [] }), callTool: async () => ({}) };
    const tool = mcpToolToTool('ci', { name: 'run' }, client);
    expect(tool.description).toBe('ci 的 MCP 工具 run');
  });
});

describe('McpHub（连接池：容错发现 + 工具取用）', () => {
  const cfg = (name: string): McpServerConfig => ({ name, transport: 'http', url: `http://x/${name}` });

  const fakeClient = (tools: McpToolDef[]): McpClientLike => ({
    listTools: async () => ({ tools }),
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  });

  it('start：成功的 server 发现工具，失败的留痕不炸；statuses/serverNames 反映真实状态', async () => {
    const hub = new McpHub(
      [cfg('good'), cfg('bad')],
      async (c) => {
        if (c.name === 'bad') throw new Error('connection refused');
        return fakeClient([{ name: 'ping', description: '探测', inputSchema: { type: 'object', properties: {} } }]);
      },
    );
    await hub.start();

    expect(hub.serverNames()).toEqual(['good']); // 失败 server 不进可用清单（能力下拉/校验数据源）
    const statuses = hub.statuses();
    const good = statuses.find((s) => s.name === 'good');
    const bad = statuses.find((s) => s.name === 'bad');
    expect(good).toMatchObject({ status: 'connected', tools: ['mcp_good_ping'] });
    expect(bad).toMatchObject({ status: 'error', error: 'connection refused', tools: [] });
  });

  it('toolsFor：按 server 名取工具；未知名忽略（校验在能力 upsert 层做）', async () => {
    const hub = new McpHub(
      [cfg('a'), cfg('b')],
      async (c) => fakeClient([{ name: `t_${c.name}`, inputSchema: undefined }]),
    );
    await hub.start();
    const tools = hub.toolsFor(['a', 'b', 'ghost']);
    expect(tools.map((t) => t.name)).toEqual(['mcp_a_t_a', 'mcp_b_t_b']);
    expect(hub.toolsFor(['ghost'])).toEqual([]);
  });
});
