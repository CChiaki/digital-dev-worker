import type { Tool, ToolParamSpec, ToolResult } from '@ddw/runtime';
import type { BrowserDriver } from './driver.js';

const need = (args: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) {
    if (typeof args[k] !== 'string') return `缺少参数 ${k}`;
  }
  return undefined;
};

function tool(name: string, description: string, params: ToolParamSpec, run: (args: Record<string, unknown>) => Promise<ToolResult>): Tool {
  return {
    name, description, parameters: params,
    async execute(args) {
      try {
        return await run(args);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** e2e 验证工具集：数字员工操作验证环境页面（浏览器执行链路） */
export function createBrowserTools(deps: { driver: BrowserDriver }): Tool[] {
  const d = deps.driver;
  return [
    tool('browser_navigate', '在验证环境浏览器中打开 URL，返回页面标题', {
      url: { type: 'string', description: '目标页面地址', required: true },
    }, async (args) => {
      const miss = need(args, ['url']);
      if (miss) return { ok: false, error: miss };
      return { ok: true, data: await d.navigate(args['url'] as string) };
    }),

    tool('browser_click', '点击页面元素（CSS 选择器）', {
      selector: { type: 'string', description: 'CSS 选择器', required: true },
    }, async (args) => {
      const miss = need(args, ['selector']);
      if (miss) return { ok: false, error: miss };
      await d.click(args['selector'] as string);
      return { ok: true, data: { clicked: args['selector'] } };
    }),

    tool('browser_fill', '向输入框填写文本', {
      selector: { type: 'string', description: '输入框 CSS 选择器', required: true },
      text: { type: 'string', description: '要填写的文本', required: true },
    }, async (args) => {
      const miss = need(args, ['selector', 'text']);
      if (miss) return { ok: false, error: miss };
      await d.fill(args['selector'] as string, args['text'] as string);
      return { ok: true, data: { filled: args['selector'] } };
    }),

    tool('browser_get_text', '读取页面元素文本', {
      selector: { type: 'string', description: 'CSS 选择器', required: true },
    }, async (args) => {
      const miss = need(args, ['selector']);
      if (miss) return { ok: false, error: miss };
      return { ok: true, data: { text: await d.getText(args['selector'] as string) } };
    }),

    tool('browser_screenshot', '截取当前页面并保存', {
      name: { type: 'string', description: '截图名称（可选）' },
    }, async (args) => {
      return { ok: true, data: await d.screenshot(typeof args['name'] === 'string' ? args['name'] : undefined) };
    }),

    tool('browser_close', '关闭浏览器页面', {}, async () => {
      await d.close();
      return { ok: true, data: { closed: true } };
    }),
  ];
}
