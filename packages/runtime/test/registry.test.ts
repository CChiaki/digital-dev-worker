import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Tool } from '../src/types.js';

const echoTool: Tool = {
  name: 'echo',
  description: '回声',
  parameters: { text: { type: 'string', description: '内容', required: true } },
  async execute(args) {
    return { ok: true, data: { echo: args.text } };
  },
};

describe('ToolRegistry', () => {
  it('注册与 get', () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    expect(reg.get('echo')).toBe(echoTool);
    expect(reg.get('nope')).toBeUndefined();
  });

  it('list 输出工具契约（供任务简报/控制台展示）', () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    expect(reg.list()).toEqual([{
      name: 'echo',
      description: '回声',
      parameters: echoTool.parameters,
    }]);
  });
});
