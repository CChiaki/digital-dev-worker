import type { BrowserDriver } from '../driver.js';

/** 内存页面模型：记录操作序列，getText/screenshot 可编程；选择器未知时抛错（模拟元素不存在）。
 *  登录模拟：requireLogin 配置后受保护导航跳登录页（title 登录特征），填表提交匹配即放行——
 *  供 ensureLogin 登录态闭环测试（冷登录 / 凭据错误 / 登录后访问受保护页）。 */
export class FakeDriver implements BrowserDriver {
  actions: unknown[] = [];
  private texts = new Map<string, string>();
  private screenshotPaths: string[] = [];
  private navigateError?: string;
  title = '测试环境';
  shotSeq = 0;

  /** 登录模拟配置：受保护导航跳登录页；填入的凭据与此匹配才放行 */
  requireLogin?: { user: string; pass: string; loginTitle?: string };
  authed = false;
  private pendingUser?: string;
  private pendingPass?: string;
  stateFile?: string;

  onText(selector: string, text: string): void {
    this.texts.set(selector, text);
  }

  onScreenshot(path: string): void {
    this.screenshotPaths.push(path);
  }

  failNavigate(reason: string): void {
    this.navigateError = reason;
  }

  async navigate(url: string): Promise<{ title?: string }> {
    if (this.navigateError) throw new Error(this.navigateError);
    this.actions.push(['navigate', url]);
    // 未登录：受保护页跳登录页（真实系统的 url 重定向 + 登录 title 特征）
    if (this.requireLogin && !this.authed) {
      this.title = this.requireLogin.loginTitle ?? '统一登录';
    } else {
      this.title = '测试环境';
    }
    return { title: this.title };
  }

  async click(selector: string): Promise<void> {
    this.actions.push(['click', selector]);
    // 模拟登录提交：凭据匹配即放行（submit 类点击时结算）
    if (this.requireLogin && !this.authed && selector === 'button[type=submit]') {
      if (this.pendingUser === this.requireLogin.user && this.pendingPass === this.requireLogin.pass) {
        this.authed = true;
      }
    }
    // 编程点击效果：点击后更新页面文本（如流转后状态字段变化）
    const effects = this.clickEffects.get(selector);
    if (effects) for (const [sel, text] of Object.entries(effects)) this.texts.set(sel, text);
  }

  private clickEffects = new Map<string, Record<string, string>>();

  /** 编程点击效果：点击 selector 后将 textMap 写入页面文本（模拟真实 UI 的状态变化） */
  onClick(selector: string, textMap: Record<string, string>): void {
    this.clickEffects.set(selector, textMap);
  }

  async fill(selector: string, text: string): Promise<void> {
    this.actions.push(['fill', selector, text]);
    if (selector === '#username') this.pendingUser = text;
    if (selector === '#password') this.pendingPass = text;
  }

  async getText(selector: string): Promise<string> {
    this.actions.push(['getText', selector]);
    const text = this.texts.get(selector);
    if (text === undefined) throw new Error(`元素不存在: ${selector}`);
    return text;
  }

  async screenshot(name?: string): Promise<{ path: string }> {
    this.actions.push(['screenshot', name]);
    const path = this.screenshotPaths[this.shotSeq++] ?? `/tmp/shots/fake-${this.shotSeq}.png`;
    return { path };
  }

  async close(): Promise<void> {
    this.actions.push(['close']);
  }

  async restoreState(path: string): Promise<void> {
    this.stateFile = path;
    // 内存模型：export 过的 storageState 路径即视为缓存文件存在（static 模拟跨"进程"的文件系统），
    // 恢复成功 = 免登录放行（真实实现由 storageState 恢复 cookie）
    if (FakeDriver.stateFiles.has(path)) this.authed = true;
  }

  async exportState(path: string): Promise<void> {
    this.stateFile = path;
    FakeDriver.stateFiles.add(path);
  }

  /** 模拟 storageState 文件库（static：跨 FakeDriver 实例共享，等同磁盘上的缓存文件） */
  static stateFiles = new Set<string>();
}
