import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Tool, ToolParamSpec } from '../types.js';

/** ToolParamSpec（产品契约）→ JSON Schema（pi 透传给 provider，P0-S6 已验证兼容） */
function toJsonSchema(params: ToolParamSpec): {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
} {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(params)) {
    properties[key] = { type: spec.type, description: spec.description };
    if (spec.required) required.push(key);
  }
  return { type: 'object', properties, required };
}

/** 我们的 Tool 契约 → pi AgentTool。
 *  - label 必填（P0 铁律 1）
 *  - ok:false 抛异常 → pi 标 isError toolResult 回灌模型（不要在 content 里编码错误）
 */
export function toPiTool(tool: Tool): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: toJsonSchema(tool.parameters),
    execute: async (_toolCallId, params) => {
      const result = await tool.execute(params as Record<string, unknown>);
      if (!result.ok) {
        throw new Error(result.error ?? `工具 ${tool.name} 执行失败`);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
