import { describe, it, expect, beforeEach } from 'vitest';
import { FakeDriver } from '../src/drivers/fake.js';
import { ensureLogin } from '../src/login.js';

/**
 * 登录态闭环单测（P14-T1，spec 7.3）：冷启动自动重登 / storageState 缓存命中跳过登录 /
 * 凭据错误可读报错（自愈闭环入口）/ 无需登录直通。全走 FakeDriver 内存页面模型。
 */

function fakeWithLogin(user = 'emp-01', pass = 'secret-pw'): FakeDriver {
  const driver = new FakeDriver();
  driver.requireLogin = { user, pass };
  return driver;
}

describe('ensureLogin（UI 适配器登录态，P14）', () => {
  beforeEach(() => {
    FakeDriver.stateFiles.clear(); // static 文件库跨用例隔离
  });

  it('冷启动重登成功：填表提交放行 + 导出 storageState 缓存', async () => {
    const driver = fakeWithLogin();
    const statePath = '/tmp/ddw-states/jira/emp-01.json';

    const result = await ensureLogin(driver, { username: 'emp-01', password: 'secret-pw' }, {
      entryUrl: 'http://jira.inner.bank/secure/Dashboard.jspa',
      statePath,
    });

    expect(result).toMatchObject({ ok: true, viaCache: false });
    expect(driver.authed).toBe(true);
    const fills = driver.actions.filter((a) => (a as unknown[])[0] === 'fill');
    expect(fills).toHaveLength(2); // 账号 + 密码
    expect(FakeDriver.stateFiles.has(statePath)).toBe(true); // 缓存落盘
  });

  it('缓存命中跳过登录：无 fill/submit 动作，viaCache=true', async () => {
    const statePath = '/tmp/ddw-states/jira/emp-02.json';
    // 第一位"进程"登录导出缓存
    const first = fakeWithLogin('emp-02', 'pw2');
    await ensureLogin(first, { username: 'emp-02', password: 'pw2' }, {
      entryUrl: 'http://jira.inner.bank/',
      statePath,
    });
    // 第二位"进程"（新实例，未登录）缓存恢复直进
    const second = fakeWithLogin('emp-02', 'pw2');
    const result = await ensureLogin(second, { username: 'emp-02', password: 'pw2' }, {
      entryUrl: 'http://jira.inner.bank/',
      statePath,
    });

    expect(result).toMatchObject({ ok: true, viaCache: true });
    expect(second.authed).toBe(true);
    expect(second.actions.some((a) => (a as unknown[])[0] === 'fill')).toBe(false);
  });

  it('凭据错误 → 可读报错（含登录页 title 与表单选择器，自愈入口）', async () => {
    const driver = fakeWithLogin();
    const result = await ensureLogin(driver, { username: 'emp-01', password: 'wrong' }, {
      entryUrl: 'http://jira.inner.bank/',
      statePath: '/tmp/ddw-states/jira/emp-01.json',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('登录失败');
    expect(result.error).toContain('#username');
    expect(driver.authed).toBe(false);
    // 失败不导出缓存（不带病缓存）
    expect(FakeDriver.stateFiles.has('/tmp/ddw-states/jira/emp-01.json')).toBe(false);
  });

  it('免登录系统（未配置 requireLogin）直通', async () => {
    const driver = new FakeDriver();
    const result = await ensureLogin(driver, { username: 'x', password: 'y' }, {
      entryUrl: 'http://testenv.inner.bank/',
    });
    expect(result).toMatchObject({ ok: true, viaCache: false });
  });
});
