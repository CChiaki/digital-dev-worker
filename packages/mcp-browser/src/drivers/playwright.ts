import { existsSync } from 'node:fs';
import type { BrowserDriver } from '../driver.js';

type PlaywrightPage = {
  goto: (url: string, opts?: object) => Promise<{ title?: () => string } | null>;
  title: () => string;
  click: (selector: string) => Promise<void>;
  fill: (selector: string, text: string) => Promise<void>;
  textContent: (selector: string) => Promise<string | null>;
  screenshot: (opts: { path: string }) => Promise<void>;
};

type PlaywrightContext = {
  newPage: () => Promise<PlaywrightPage>;
  storageState: (opts?: { path?: string }) => Promise<unknown>;
};
type PlaywrightBrowser = {
  close: () => Promise<void>;
  newContext: (opts?: { storageState?: string }) => Promise<PlaywrightContext>;
};
type PlaywrightModule = {
  chromium: {
    launch: (opts?: object) => Promise<PlaywrightBrowser>;
  };
};

/** Playwright 生产驱动：懒加载 playwright 依赖（内网安装后即用；未安装给出可读错误）。
 *  登录态：restoreState 的 storageState 文件在首次 ensure（newContext）时生效，须先于 navigate 调用。 */
export class PlaywrightDriver implements BrowserDriver {
  private mod?: PlaywrightModule;
  private browser?: PlaywrightBrowser;
  private context?: PlaywrightContext;
  private page?: PlaywrightPage;
  private statePath?: string;

  private async ensure(): Promise<{ page: PlaywrightPage }> {
    if (this.page && this.mod) return { page: this.page };
    try {
      this.mod = await import('playwright' as string) as PlaywrightModule;
    } catch {
      throw new Error('playwright 未安装：请在内网镜像安装 playwright 与浏览器内核后重试');
    }
    this.browser = await this.mod.chromium.launch({ headless: true });
    this.context = await this.browser.newContext(this.statePath ? { storageState: this.statePath } : undefined);
    this.page = await this.context.newPage();
    return { page: this.page };
  }

  async restoreState(path: string): Promise<void> {
    if (this.page) throw new Error('restoreState 须在首次 navigate 前调用（storageState 在 newContext 时生效）');
    if (!existsSync(path)) return; // 无缓存文件 = 冷启动照常
    this.statePath = path;
  }

  async exportState(path: string): Promise<void> {
    if (!this.context) throw new Error('exportState 须在页面打开后调用');
    await this.context.storageState({ path });
  }

  async navigate(url: string): Promise<{ title?: string }> {
    const { page } = await this.ensure();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { title: page.title() };
  }

  async click(selector: string): Promise<void> {
    const { page } = await this.ensure();
    await page.click(selector);
  }

  async fill(selector: string, text: string): Promise<void> {
    const { page } = await this.ensure();
    await page.fill(selector, text);
  }

  async getText(selector: string): Promise<string> {
    const { page } = await this.ensure();
    const text = await page.textContent(selector);
    if (text === null) throw new Error(`元素不存在: ${selector}`);
    return text;
  }

  async screenshot(name?: string): Promise<{ path: string }> {
    const { page } = await this.ensure();
    const path = `/tmp/ddw-shots/${name ?? `shot-${Date.now()}`}.png`;
    await page.screenshot({ path });
    return { path };
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
  }
}
