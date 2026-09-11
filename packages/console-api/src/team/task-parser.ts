import { parseTaskPackage, type ModelGateway } from '@ddw/runtime';

/** 从模型回复中提取 yaml 代码块（```yaml ... ```；无围栏时整段原文兜底） */
export function extractYamlBlock(reply: string): string {
  const fenced = reply.match(/```(?:yaml)?\s*\n([\s\S]*?)```/);
  return (fenced?.[1] ?? reply).trim();
}

/** 能力矩阵条目（生成提示词注入用：kind → 用途 + 工具包，来源能力管理注册表） */
export interface CapabilityBrief {
  kind: string;
  name?: string;
  description?: string;
  builtin?: string[];
  mcp?: string[];
}

/** MCP server 已发现工具（生成提示词注入用：server 名 → 带 mcp_{server}_ 前缀的工具名） */
export interface McpToolBrief {
  server: string;
  tools: string[];
}

/** 系统提示词：任务包 schema 约束 + 仅允许的 kind 白名单（生成 kind 必须取自注册表）
 *  + 能力矩阵与 MCP 工具清单（2026-09-10：生成 detail 优先落到已接入能力，不再编 REST API 方案） */
export function buildTaskParseSystemPrompt(
  kinds: string[],
  caps: CapabilityBrief[] = [],
  mcpTools: McpToolBrief[] = [],
): string {
  const lines = [
    '你是研发任务包生成器。把用户的自然语言需求描述转换为任务包 yaml（只输出 yaml，不要解释）。',
    '输出格式：仅输出一个 ```yaml 围栏代码块。',
    '严格遵循如下 schema：',
    'taskId: <kebab-case 唯一标识>, title: <中文标题>,',
    'repo: { url: <git 仓库地址>, branch: <分支>, baseBranch?: <基线分支> },',
    'role?: <岗位>, dependsOn?: [任务包id],',
    'plan: [ { id: <t1/t2...>, kind?: <能力类型>, title: <项标题>, detail: <该项要做什么>, verify?: <验证命令> } ]',
    `kind 只能取以下已注册值（缺省 dev）：${kinds.join(', ') || 'dev'}。`,
    'plan 与 tasks 互斥，用 plan。每个 plan 项的 detail 要具体可执行；关键项（commit/test）建议配 verify 命令。',
    'verify 铁律：必须是可直接在工作区执行的 shell 命令（grep/ls/git 等），不得写中文描述或 <占位符>；写不出可靠命令就整个省略 verify 字段。',
    'verify 注意：commit 类节点的提交经托管平台 API 落远端，本地工作区 git 历史不随之更新——commit 节点的 verify 禁止用 git log/git status 校验提交结果，应省略 verify 或改为校验工作区文件内容。',
    '不要编造仓库地址——若用户未给出 repo.url，用占位 "http://localhost:3000/demo/CHANGE-ME.git" 并在 title 后加「（仓库待定）」。',
    // 格式铁律（2026-09-06 实战坏例）：模型一行写多个键且值内含冒号引号 → yaml "Nested mappings" 解析失败
    '格式铁律：每个键必须独占一行，严禁在同一行写多个键；plan 项用 "- id: t1" 起行，其余字段换行缩进对齐。',
    '值中包含冒号、引号、括号等特殊字符时（如 git 命令），整个值用双引号包裹，内部双引号用 \\" 转义。',
  ];
  if (caps.length || mcpTools.length) {
    lines.push('能力矩阵（kind → 用途与工具包，动作必须优先落到这些已接入能力上）：');
    for (const c of caps) {
      const parts: string[] = [];
      if (c.builtin?.length) parts.push(`内置 ${c.builtin.join('/')}`);
      if (c.mcp?.length) parts.push(`MCP ${c.mcp.join('/')}`);
      lines.push(`- ${c.kind}${c.name ? `「${c.name}」` : ''}${c.description ? `：${c.description}` : ''}${parts.length ? `（工具: ${parts.join(' + ')}）` : ''}`);
    }
    if (mcpTools.length) {
      lines.push('MCP 已发现工具（detail 中按名引用，工具名逐字照抄、不得编造）：');
      for (const m of mcpTools) lines.push(`- ${m.server}: ${m.tools.join(', ')}`);
    }
    lines.push('生成 detail 时动作优先调 MCP 工具完成——能调工具的绝不写 REST API/curl/手工脚本替代方案（例：触发 Jenkins 构建应写「调用 jenkins MCP 工具 mcp_jenkins_jenkins_trigger_build 触发构建」，而不是调用 Jenkins REST API）。');
    lines.push('能力矩阵与工具清单覆盖不到的动作，才写通用执行步骤。');
  }
  return lines.join('\n');
}

/** 自愈重试的系统提示词：把解析错误回传模型修正 yaml（2026-09-06） */
export function buildYamlFixSystemPrompt(): string {
  return [
    '你是 yaml 修复器。用户消息包含一段任务包 yaml 及其解析错误，只输出修正后的完整任务包 yaml（```yaml 围栏代码块），不要解释。',
    '格式铁律：每个键必须独占一行，严禁同一行写多个键；值中包含冒号、引号、括号等特殊字符时，整个值用双引号包裹（内部双引号用 \\" 转义）。',
  ].join('\n');
}

/**
 * 模型回复归一化为纯文本：
 * - 测试/简单注入的 StreamFn 直接 resolve string；
 * - 生产 pi-ai 缺省适配器返回 AssistantMessageEventStream（result() → AssistantMessage），
 *   取其 text 内容块拼接。
 */
export async function replyToText(reply: unknown): Promise<string> {
  if (typeof reply === 'string') return reply;
  const streamable = reply as { result?: () => Promise<{ content?: Array<{ type?: string; text?: string }> }> };
  if (reply && typeof streamable.result === 'function') {
    const msg = await streamable.result();
    return (msg.content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
  }
  throw new Error('智能生成失败：模型流返回了无法识别的结果类型');
}

/** 从模型回复中提取 JSON 数组（```json 围栏优先，其次首个 [ ... ] 区段；无则抛错） */
export function extractJsonArray(reply: string): unknown[] {
  const fenced = reply.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const text = fenced?.[1] ?? reply;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('模型输出中未找到 JSON 数组');
  return JSON.parse(text.slice(start, end + 1)) as unknown[];
}

/** AI 解析：用户描述 → 任务包 yaml（过 parseTaskPackage 与 kind 白名单双重校验，失败抛可读错误）。
 *  capabilityCtx（2026-09-10 可选）：能力矩阵 + MCP 已发现工具，注入提示词让生成的
 *  detail 优先落到已接入能力/MCP 工具，而非自编 REST API 方案 */
export async function parseTaskDescription(
  gateway: ModelGateway, description: string, enabledKinds: () => Promise<string[]>,
  capabilityCtx?: () => Promise<{ caps: CapabilityBrief[]; mcpTools: McpToolBrief[] }>,
): Promise<string> {
  const kinds = await enabledKinds();
  const ctx = await capabilityCtx?.().catch(() => ({ caps: [], mcpTools: [] as McpToolBrief[] })) ?? { caps: [], mcpTools: [] as McpToolBrief[] };
  const stream = gateway.streamFnFor('chat');
  const raw = await stream(gateway.modelFor('chat'), {
    systemPrompt: buildTaskParseSystemPrompt(kinds, ctx.caps, ctx.mcpTools),
    messages: [{ role: 'user', content: description, timestamp: Date.now() }],
  } as never);
  const reply = await replyToText(raw);
  let yaml = extractYamlBlock(reply);
  let pkg: ReturnType<typeof parseTaskPackage>;
  try {
    pkg = parseTaskPackage(yaml);
  } catch (firstError) {
    // 自愈重试（2026-09-06）：把解析错误回传模型修正一次，修正结果过校验则采用，仍失败才报可读错误
    const firstMsg = firstError instanceof Error ? firstError.message : String(firstError);
    const fix = await stream(gateway.modelFor('chat'), {
      systemPrompt: buildYamlFixSystemPrompt(),
      messages: [{
        role: 'user',
        content: `任务包 yaml：\n${yaml}\n\n解析错误：\n${firstMsg}\n\n请输出修正后的完整任务包 yaml。`,
        timestamp: Date.now(),
      }],
    } as never);
    const fixed = extractYamlBlock(await replyToText(fix));
    try {
      pkg = parseTaskPackage(fixed);
      yaml = fixed; // 采纳修正后的 yaml（前端预填的就是可解析版本）
    } catch {
      throw new Error(`智能生成失败：模型输出不是合法任务包（${firstMsg}）`);
    }
  }
  for (const item of pkg.plan ?? []) {
    const kind = item.kind ?? 'dev';
    if (!kinds.includes(kind)) {
      throw new Error(`智能生成失败：模型输出的任务项 ${item.id}.kind='${kind}' 未注册（可用: ${kinds.join(', ')}），请调整描述或改用手动模式`);
    }
  }
  return yaml;
}
