import { describe, it, expect, beforeEach } from 'vitest';
import { FakeDriver } from '@ddw/mcp-browser';
import { createJiraUiTools, JIRA_UI_SELECTORS } from '../src/ui-adapter.js';
import type { Tool } from '@ddw/runtime';

/**
 * Jira UI 适配器单测（P14-T2，spec 7.3 垫片）：同契约 ui 实现——
 * 查单读详情 / 流转幂等前置读（already）/ 评论填表提交 / 未登录自动重登 /
 * 失败可读报错（页面文本 + 截图路径，自愈闭环入口）。全走 FakeDriver 内存页面。
 */

const LOGIN = {
  entryUrl: 'http://jira.inner.bank/secure/Dashboard.jspa',
  statePath: '/tmp/ddw-states/jira/emp-01.json',
  credentials: { username: 'emp-01', password: 'secret-pw' },
};

const S = JIRA_UI_SELECTORS;

let driver: FakeDriver;
let tools: Tool[];
const get = (name: string): Tool => tools.find((t) => t.name === name)!;

beforeEach(() => {
  FakeDriver.stateFiles.clear();
  driver = new FakeDriver();
  driver.requireLogin = { user: 'emp-01', pass: 'secret-pw' };
  tools = createJiraUiTools({
    driver,
    options: { baseUrl: 'http://jira.inner.bank', login: LOGIN },
  });
});

describe('createJiraUiTools（Jira UI 适配器，P14）', () => {
  it('三工具同契约且 impl: ui 标注', () => {
    expect(tools.map((t) => t.name)).toEqual(['jira_get_issue', 'jira_update_status', 'jira_add_comment']);
    expect(tools.every((t) => t.impl === 'ui')).toBe(true);
  });

  it('查单：登录后读详情页 summary/status/description + 截图路径', async () => {
    driver.onText(S.summary, '修复登录超时');
    driver.onText(S.status, '待开发');
    driver.onText(S.description, '超时阈值 30s → 60s');

    const res = await get('jira_get_issue').execute({ key: 'TASK-123' });

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      key: 'TASK-123',
      summary: '修复登录超时',
      status: '待开发',
      description: '超时阈值 30s → 60s',
    });
    expect((res.data as { screenshot: string }).screenshot).toBeTruthy();
    // 详情页路径来自 baseUrl（排除登录入口页的 navigate）
    const navs = driver.actions.filter((a) => (a as unknown[])[0] === 'navigate').map((a) => (a as unknown[])[1]);
    expect(navs).toContain('http://jira.inner.bank/browse/TASK-123');
  });

  it('流转幂等：已是目标状态直接 already:true，不触发流转点击', async () => {
    driver.onText(S.summary, 's');
    driver.onText(S.status, '开发中');
    driver.onText(S.description, 'd');

    const res = await get('jira_update_status').execute({ key: 'TASK-123', status: '开发中' });

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ key: 'TASK-123', status: '开发中', already: true });
    // 无流转点击（登录提交的 click 除外）
    const clicks = driver.actions.filter((a) => (a as unknown[])[0] === 'click').map((a) => (a as unknown[])[1]);
    expect(clicks).not.toContain(S.transitionTrigger);
  });

  it('流转：点击流转菜单 + 目标状态项；确认读拦截「未生效」为可读报错；再查幂等', async () => {
    driver.onText(S.summary, 's');
    driver.onText(S.status, '待开发');
    driver.onText(S.description, 'd');

    // FakeDriver click 无副作用 → 状态没变 → 确认读拦截（= 真实系统流转路径不存在时的可读报错路径）
    const res = await get('jira_update_status').execute({ key: 'TASK-123', status: '开发中' });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('未生效');
    // 流转动作已发生：触发按钮 + 目标状态项
    const clicked = driver.actions.filter((a) => (a as unknown[])[0] === 'click').map((a) => (a as unknown[])[1]);
    expect(clicked).toContain(S.transitionTrigger);
    expect(clicked).toContain(S.transitionItem('开发中'));

    // 状态生效后再查：幂等前置读直接 already:true，无新增点击
    const clicksBefore = driver.actions.filter((a) => (a as unknown[])[0] === 'click').length;
    driver.onText(S.status, '开发中');
    const res2 = await get('jira_update_status').execute({ key: 'TASK-123', status: '开发中' });
    expect(res2.ok).toBe(true);
    expect(res2.data).toMatchObject({ key: 'TASK-123', status: '开发中', already: true });
    expect(driver.actions.filter((a) => (a as unknown[])[0] === 'click')).toHaveLength(clicksBefore);
  });

  it('评论：填评论框 + 提交，返回截图证据', async () => {
    driver.onText(S.summary, 's');
    driver.onText(S.status, '开发中');
    driver.onText(S.description, 'd');

    const res = await get('jira_add_comment').execute({ key: 'TASK-123', body: '已提 MR，待构建' });

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ key: 'TASK-123', commented: true });
    const fills = driver.actions.filter((a) => (a as unknown[])[0] === 'fill');
    expect(fills).toContainEqual(['fill', S.commentInput, '已提 MR，待构建']);
    expect((res.data as { screenshot: string }).screenshot).toBeTruthy();
  });

  it('未登录自动重登：首个工具执行前触发 ensureLogin（填表提交）', async () => {
    driver.onText(S.summary, 's');
    driver.onText(S.status, '开放');
    driver.onText(S.description, 'd');

    const res = await get('jira_get_issue').execute({ key: 'TASK-9' });

    expect(res.ok).toBe(true);
    expect(driver.authed).toBe(true);
    expect(driver.actions.some((a) => (a as unknown[])[0] === 'fill')).toBe(true);
  });

  it('导航失败 → 可读错误含页面文本片段与截图路径（自愈闭环入口）', async () => {
    driver.onText(S.pageBody, '系统维护中，请稍后再试');
    driver.failNavigate('net timeout');

    const res = await get('jira_get_issue').execute({ key: 'TASK-9' });

    expect(res.ok).toBe(false);
    const err = (res as { error: string }).error;
    expect(err).toContain('Jira UI 查单 失败');
    expect(err).toContain('net timeout');
    expect(err).toContain('系统维护中');
    expect(err).toMatch(/现场截图: \S+\.png/);
  });
});
