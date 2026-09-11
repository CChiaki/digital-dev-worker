import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@ddw/runtime';

/**
 * 标准 MCP 协议客户端接入（2026-09-06 用户需求 A+B）：runtime yaml 注册 mcpServers，
 * 服务启动时 initialize + tools/list 自动发现工具并转成本工程 Tool 契约注册——
 * 新接一个 MCP server 只改 yaml 配置，零代码改动，能力管理界面自动展示（server 名即工具包标识）。
 */

/** MCP server 连接配置（runtime yaml mcpServers 段；token 等凭据支持 enc:v1: 密文由 resolveRuntimeSecrets 处理） */
export interface McpServerConfig {
  /** 工具包标识（能力 tools.mcp 引用；工具名前缀 mcp_{name}_） */
  name: string;
  transport: 'stdio' | 'http';
  /** stdio：启动命令（如 npx -y some-mcp-server） */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http：Streamable HTTP 端点（如 http://mcp-gateway.inner.bank/gitlab/mcp） */
  url?: string;
  headers?: Record<string, string>;
}

/** MCP tools/list 返回的工具定义（inputSchema 为 JSON Schema） */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

/** 测试可注入的最小 client 契约（SDK Client 的子集） */
export interface McpClientLike {
  listTools(): Promise<{ tools: McpToolDef[] }>;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<{
    content?: { type?: string; text?: string }[];
    isError?: boolean;
  }>;
}

/** 工具结果 content → 文本（text 项拼接，无 text 时序列化兜底——模型读得懂即可） */
function contentToText(content: { type?: string; text?: string }[] | undefined): string {
  if (!content?.length) return '';
  const texts = content.filter((c) => typeof c.text === 'string').map((c) => c.text!);
  if (texts.length > 0) return texts.join('\n');
  return JSON.stringify(content);
}

/**
 * MCP JSON Schema → 本工程 ToolParamSpec（扁平 properties；required 数组标注必填）。
 * 非扁平 schema（嵌套 object/array）type 原样透传，模型按 JSON Schema 语义理解。
 */
export function jsonSchemaToParamSpec(
  schema: McpToolDef['inputSchema'],
): Record<string, { type: string; description: string; required?: boolean }> {
  const spec: Record<string, { type: string; description: string; required?: boolean }> = {};
  const props = schema?.properties ?? {};
  for (const [key, p] of Object.entries(props)) {
    spec[key] = {
      type: typeof p.type === 'string' ? p.type : 'string',
      description: typeof p.description === 'string' ? p.description : '',
      ...(schema?.required?.includes(key) ? { required: true } : {}),
    };
  }
  return spec;
}

/** 单个 MCP 工具 → 本工程 Tool（名称加前缀 mcp_{server}_ 防与内置工具/server 间重名冲突） */
export function mcpToolToTool(server: string, def: McpToolDef, client: McpClientLike): Tool {
  const prefixed = `mcp_${server}_${def.name}`;
  return {
    name: prefixed,
    description: def.description ?? `${server} 的 MCP 工具 ${def.name}`,
    parameters: jsonSchemaToParamSpec(def.inputSchema),
    async execute(args: Record<string, unknown>) {
      const result = await client.callTool({ name: def.name, arguments: args });
      const text = contentToText(result.content);
      if (result.isError) return { ok: false, error: text || 'MCP 工具执行失败' };
      return { ok: true, ...(text ? { data: text } : {}) };
    },
  };
}

/** server 连接器（可注入测试替身）；缺省按 transport 构造 SDK Client + transport 并 connect */
export type McpClientFactory = (cfg: McpServerConfig) => Promise<McpClientLike>;

const defaultClientFactory: McpClientFactory = async (cfg) => {
  const client = new Client({ name: 'ddw-console', version: '1.0.0' });
  const transport =
    cfg.transport === 'stdio'
      ? new StdioClientTransport({
          command: cfg.command!,
          ...(cfg.args ? { args: cfg.args } : {}),
          ...(cfg.env ? { env: { ...process.env, ...cfg.env } as Record<string, string> } : {}),
        })
      : new StreamableHTTPClientTransport(new URL(cfg.url!), {
          ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {}),
        });
  await client.connect(transport);
  return client as unknown as McpClientLike;
};

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'error';
  error?: string;
  /** 已发现的工具名（带 mcp_{server}_ 前缀的最终注册名） */
  tools: string[];
}

/** 工具源最小契约（default-tools.ts 依赖此接口，避免反向依赖 hub 具体实现） */
export interface McpToolSource {
  /** 按 server 名集合取全部已发现工具（未知名忽略——校验在能力 upsert 层做） */
  toolsFor(names: string[]): Tool[];
  /** 已注册 server 名（能力管理下拉/mcp 校验数据源） */
  serverNames(): string[];
}

/**
 * MCP server 连接池：start 并发连接全部（失败容错留痕，不炸启动——单个 server 挂了
 * 只影响引用它的能力，员工执行时缺工具自然暴露）。listTools 结果缓存：工具集发现一次，
 * callTool 走 client 常驻连接（SDK 支持并发请求复用连接）。
 */
export class McpHub implements McpToolSource {
  private clients = new Map<string, McpClientLike>();
  private tools = new Map<string, Tool[]>();
  private errors = new Map<string, string>();
  private readonly factory: McpClientFactory;

  constructor(
    private readonly servers: McpServerConfig[],
    factory?: McpClientFactory,
  ) {
    this.factory = factory ?? defaultClientFactory;
  }

  /** 连接全部 server 并发现工具；单 server 失败不阻塞其余（Promise.allSettled 语义） */
  async start(): Promise<void> {
    await Promise.all(
      this.servers.map(async (cfg) => {
        try {
          const client = await this.factory(cfg);
          const { tools } = await client.listTools();
          this.clients.set(cfg.name, client);
          this.tools.set(cfg.name, tools.map((t) => mcpToolToTool(cfg.name, t, client)));
        } catch (e) {
          // 留痕不炸：mcp-servers 接口可见 error 状态，能力引用了坏 server 时执行期才暴露
          this.errors.set(cfg.name, e instanceof Error ? e.message : String(e));
        }
      }),
    );
  }

  toolsFor(names: string[]): Tool[] {
    return names.flatMap((n) => this.tools.get(n) ?? []);
  }

  serverNames(): string[] {
    return [...this.tools.keys()];
  }

  statuses(): McpServerStatus[] {
    return this.servers.map((cfg) => {
      const error = this.errors.get(cfg.name);
      if (error) return { name: cfg.name, status: 'error' as const, error, tools: [] };
      return {
        name: cfg.name,
        status: 'connected' as const,
        tools: (this.tools.get(cfg.name) ?? []).map((t) => t.name),
      };
    });
  }

  async stop(): Promise<void> {
    // SDK client.close 关连接/收 stdio 子进程；失败静默（进程退出路径无需精确清理）
    await Promise.all(
      [...this.clients.values()].map((c) => (c as unknown as { close?: () => Promise<void> }).close?.().catch(() => undefined)),
    );
  }
}
