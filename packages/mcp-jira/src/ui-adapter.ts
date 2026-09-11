import type { Tool, ToolResult } from '@ddw/runtime';
import { ensureLogin, type BrowserDriver, type EnsureLoginOptions } from '@ddw/mcp-browser';

/**
 * Jira UI 适配器（P14，spec 7.3 Playwright 垫片）：与 createJiraTools（api 形态）同契约的
 * ui 实现——jira_get_issue / jira_update_status / jira_add_comment，走浏览器原子动作。
 * 行内 Jira 无开放 API（"钉子户"系统）时注入本实现，数字员工与任务包零改动。
 *
 * 设计要点（spec 7.3）：
 * - 选择器集中在 JIRA_UI_SELECTORS 一处：页面改版只改这里
 * - update_status 幂等前置读：已是目标态直接 ok（重试/重复分派安全）
 * - 每次 UI 操作留截图（审计证据，比纯 API 调用更可审计）
 * - 失败报可读错误（含当前页面文本片段 + 截图路径）——模型自纠偏 / 盯梢人看截图判断的入口
 * - 登录态 ensureLogin 共用（storageState 缓存 + 过期自动重登；凭据解密在组装方 resolveSecret）
 */

/** Jira Web 页面选择器（集中管理：页面改版只改一处） */
export const JIRA_UI_SELECTORS = {
  summary: '#summary-field',
  status: '#status-field',
  description: '#description-field',
  transitionTrigger: '#opsbar-transition_submit',
  transitionItem: (status: string): string => `#transition-item-${encodeURIComponent(status)}`,
  commentTrigger: '#footer-comment-button',
  commentInput: '#comment-input',
  commentSubmit: '#issue-comment-add-submit',
  pageBody: 'body',
} as const;

export interface JiraUiAdapterOptions {
  /** Jira 根地址，如 http://jira.inner.bank */
  baseUrl: string;
  /** 登录配置（entryUrl/storageState 缓存/表单选择器覆盖）+ 凭据（解密后的明文） */
  login: EnsureLoginOptions & { credentials: { username: string; password: string } };
  /** 详情页路径模板，默认 /browse/<key> */
  issuePath?: (key: string) => string;
}

export function createJiraUiTools(deps: { driver: BrowserDriver; options: JiraUiAdapterOptions }): Tool[] {
  const { driver, options } = deps;
  const S = JIRA_UI_SELECTORS;
  const issueUrl = (key: string): string =>
    `${options.baseUrl.replace(/\/$/, '')}${options.issuePath ? options.issuePath(key) : `/browse/${key}`}`;

  // 登录态惰性单飞：成功后复用；失败不缓存（下次调用重试，避免带病会话）
  let loginPromise: Promise<{ ok: boolean; error?: string }> | undefined;
  const ensureReady = (): Promise<{ ok: boolean; error?: string }> => {
    loginPromise ??= ensureLogin(driver, options.login.credentials, options.login).catch(
      (e): { ok: boolean; error?: string } => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return loginPromise;
  };

  /** 失败可读（自愈闭环入口）：页面文本片段 + 现场截图路径 */
  const failWithEvidence = async (name: string, reason: string): Promise<ToolResult> => {
    let evidence = '';
    try {
      const shot = await driver.screenshot(`jira-ui-fail-${name}`);
      const pageText = await driver.getText(S.pageBody);
      evidence = `；当前页面文本片段: ${pageText.slice(0, 200)}；现场截图: ${shot.path}`;
    } catch {
      evidence = '；（现场截图/页面文本采集失败）';
    }
    return { ok: false, error: `Jira UI ${name} 失败: ${reason}${evidence}` };
  };

  /** 统一包装：登录态前置 + 失败证据（截图 + 页面文本） */
  const ui = (name: string, run: (args: Record<string, unknown>) => Promise<ToolResult>): Tool['execute'] => {
    return async (args) => {
      const ready = await ensureReady();
      if (!ready.ok) return failWithEvidence(name, ready.error ?? '登录失败');
      try {
        return await run(args);
      } catch (e) {
        return failWithEvidence(name, e instanceof Error ? e.message : String(e));
      }
    };
  };

  const readIssue = async (key: string): Promise<{ summary: string; status: string; description: string; screenshot: string }> => {
    await driver.navigate(issueUrl(key));
    const [summary, status, description, shot] = await Promise.all([
      driver.getText(S.summary),
      driver.getText(S.status),
      driver.getText(S.description),
      driver.screenshot(`jira-view-${key}`),
    ]);
    return { summary, status, description, screenshot: shot.path };
  };

  const getIssue: Tool = {
    name: 'jira_get_issue',
    impl: 'ui',
    description: '查询 Jira 单（summary/状态/描述；UI 通道）',
    parameters: {
      key: { type: 'string', description: 'Jira 单号，如 TASK-123', required: true },
    },
    execute: ui('查单', async (args) => {
      const key = String(args['key']);
      const { summary, status, description, screenshot } = await readIssue(key);
      return { ok: true, data: { key, summary, status, description, screenshot } };
    }),
  };

  const updateStatus: Tool = {
    name: 'jira_update_status',
    impl: 'ui',
    description: '流转 Jira 单状态（UI 通道；先读现状态幂等）',
    parameters: {
      key: { type: 'string', description: 'Jira 单号', required: true },
      status: { type: 'string', description: '目标状态名（如 开发中/待测试）', required: true },
    },
    execute: ui('流转', async (args) => {
      const key = String(args['key']);
      const status = String(args['status']);
      // 幂等前置读（spec：UI 操作前先读状态，避免重试造成重复操作）
      const current = await readIssue(key);
      if (current.status === status) {
        return { ok: true, data: { key, status, already: true, screenshot: current.screenshot } };
      }
      await driver.click(S.transitionTrigger);
      await driver.click(S.transitionItem(status));
      // 操作后确认读：状态未变 = 流转菜单里没有目标项（可读报错，附可用状态）
      const after = await readIssue(key);
      if (after.status !== status) {
        return { ok: false, error: `Jira UI 流转后状态仍为「${after.status}」，目标「${status}」未生效（可能该单无此流转路径）；截图: ${after.screenshot}` };
      }
      return { ok: true, data: { key, status, screenshot: after.screenshot } };
    }),
  };

  const addComment: Tool = {
    name: 'jira_add_comment',
    impl: 'ui',
    description: '给 Jira 单添加评论（UI 通道）',
    parameters: {
      key: { type: 'string', description: 'Jira 单号', required: true },
      body: { type: 'string', description: '评论内容', required: true },
    },
    execute: ui('评论', async (args) => {
      const key = String(args['key']);
      const body = String(args['body']);
      await driver.navigate(issueUrl(key));
      await driver.click(S.commentTrigger);
      await driver.fill(S.commentInput, body);
      await driver.click(S.commentSubmit);
      const shot = await driver.screenshot(`jira-comment-${key}`);
      return { ok: true, data: { key, commented: true, screenshot: shot.path } };
    }),
  };

  return [getIssue, updateStatus, addComment];
}
