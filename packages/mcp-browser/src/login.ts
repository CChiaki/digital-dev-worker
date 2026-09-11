import type { BrowserDriver } from './driver.js';

/**
 * 登录态管理（spec 7.3 凭据与登录）：UI 适配器共用入口。
 * 试点选型硬排除项照 spec：验证码 / SSO 跳转 / 短信、UKey 二次认证的系统不接。
 *
 * 流程：storageState 缓存恢复（有则大概率免登录）→ 导航入口页 → 登录页特征检测
 * → 填账号密码提交 → 重试导航 → 仍登录页 = 可读错误（凭据错误或选择器过时，自愈闭环入口）
 * → 登录成功导出 storageState 缓存（per 员工×系统一个文件，下次冷启动跳过登录）。
 *
 * 凭据解密在组装方完成（resolveSecret 明文/enc:v1: 两用，P11）；本模块只收明文。
 */
export interface EnsureLoginOptions {
  /** 受保护系统入口 URL（如 http://jira.inner.bank/secure/Dashboard.jspa） */
  entryUrl: string;
  /** storageState 缓存文件路径（per 员工×系统，如 <root>/<system>/<employee>.json）；缺省无缓存 */
  statePath?: string;
  /** 页面 title 含此串视为登录页（真实系统登录页 title 特征），默认 '登录' */
  loginTitleHint?: string;
  /** 登录表单选择器（默认通用约定；行内系统改版只改组装配置，不动适配器逻辑） */
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface LoginResult {
  ok: boolean;
  /** true = 本次未走登录表单（缓存恢复直接进入）；false = 现场重新登录 */
  viaCache?: boolean;
  error?: string;
}

const SEL = {
  username: '#username',
  password: '#password',
  submit: 'button[type=submit]',
} as const;

export async function ensureLogin(
  driver: BrowserDriver,
  credentials: LoginCredentials,
  opts: EnsureLoginOptions,
): Promise<LoginResult> {
  const loginTitleHint = opts.loginTitleHint ?? '登录';
  const userSel = opts.usernameSelector ?? SEL.username;
  const passSel = opts.passwordSelector ?? SEL.password;
  const submitSel = opts.submitSelector ?? SEL.submit;

  // 1. storageState 缓存恢复（存在性由 driver 实现自判——Fake 为内存语义，Playwright 为真实文件）
  let viaCache = false;
  if (opts.statePath && driver.restoreState) {
    await driver.restoreState(opts.statePath);
    viaCache = true;
  }

  // 2. 导航入口页 + 登录页检测
  const first = await driver.navigate(opts.entryUrl);
  if (!isLoginPage(first.title, loginTitleHint)) {
    return { ok: true, ...(viaCache ? { viaCache: true } : { viaCache: false }) };
  }

  // 3. 登录页：填表提交（缓存失效/首次冷启动）
  await driver.fill(userSel, credentials.username);
  await driver.fill(passSel, credentials.password);
  await driver.click(submitSel);

  // 4. 重试导航：仍登录页 = 凭据错误或选择器过时（错误可读，含表单选择器，盯梢人可判）
  const second = await driver.navigate(opts.entryUrl);
  if (isLoginPage(second.title, loginTitleHint)) {
    return {
      ok: false,
      error: `登录失败：登录后仍停留在登录页（title: ${second.title ?? '无'}）。`
        + `常见原因：凭据错误、验证码/SSO 等未接的认证方式、或登录表单选择器过时（${userSel}/${passSel}/${submitSel}）。`
        + `请核对账号状态与 SOP；截图见控制台执行档案。`,
    };
  }

  // 5. 登录成功：导出 storageState 缓存（driver 不实现 = 无缓存，下次冷登录）
  if (opts.statePath && driver.exportState) {
    await driver.exportState(opts.statePath);
  }
  return { ok: true, viaCache: false };
}

function isLoginPage(title: string | undefined, hint: string): boolean {
  return typeof title === 'string' && title.includes(hint);
}
