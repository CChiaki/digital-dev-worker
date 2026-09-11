/**
 * 浏览器驱动接口（spec 7.1：Tool 契约稳定，transport 可替换）。
 * 生产 = PlaywrightDriver（真浏览器，e2e 验证）；测试 = FakeDriver（内存页面模型）。
 */
export interface BrowserDriver {
  navigate(url: string): Promise<{ title?: string }>;
  click(selector: string): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  getText(selector: string): Promise<string>;
  screenshot(name?: string): Promise<{ path: string }>;
  close(): Promise<void>;
  /** 恢复登录态（storageState 文件；须在首次 navigate 前调用）。不实现 = 每次冷启动重新登录 */
  restoreState?(path: string): Promise<void>;
  /** 导出当前登录态到文件（登录成功后调用，供下次冷启动跳过登录）。不实现 = 无缓存 */
  exportState?(path: string): Promise<void>;
}
