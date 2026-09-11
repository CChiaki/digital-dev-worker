import { describe, it, expect, beforeEach } from 'vitest';
import { createBrowserTools } from '../src/tools.js';
import { FakeDriver } from '../src/drivers/fake.js';
import type { Tool } from '@ddw/runtime';

let driver: FakeDriver;
let tools: Map<string, Tool>;

beforeEach(() => {
  driver = new FakeDriver();
  driver.onText('h1', '欢迎登录');
  driver.onScreenshot('/tmp/shots/shot-1.png');
  tools = new Map(createBrowserTools({ driver }).map((t) => [t.name, t]));
});

describe('browser 工具 → driver 调用链', () => {
  it('browser_navigate 调 driver.navigate 并返回 title', async () => {
    const r = await tools.get('browser_navigate')!.execute({ url: 'http://testenv.local/login' });
    expect(r).toEqual({ ok: true, data: { title: '测试环境' } });
    expect(driver.actions).toContainEqual(['navigate', 'http://testenv.local/login']);
  });

  it('browser_fill + browser_click 序列正确', async () => {
    await tools.get('browser_fill')!.execute({ selector: '#username', text: 'emp-01' });
    await tools.get('browser_click')!.execute({ selector: 'button[type=submit]' });
    expect(driver.actions).toEqual([
      ['fill', '#username', 'emp-01'],
      ['click', 'button[type=submit]'],
    ]);
  });

  it('browser_get_text 返回文本', async () => {
    await tools.get('browser_navigate')!.execute({ url: 'http://testenv.local/' });
    const r = await tools.get('browser_get_text')!.execute({ selector: 'h1' });
    expect(r).toEqual({ ok: true, data: { text: '欢迎登录' } });
  });

  it('browser_screenshot 返回路径', async () => {
    const r = await tools.get('browser_screenshot')!.execute({ name: 'login' });
    expect(r.ok).toBe(true);
    expect((r as { data: { path: string } }).data.path).toContain('shot-1.png');
  });

  it('browser_close 关闭页面', async () => {
    await tools.get('browser_close')!.execute({});
    expect(driver.actions).toContainEqual(['close']);
  });
});

describe('错误路径（driver 抛错 → ok:false）', () => {
  it('元素不存在 → ok:false 带选择器', async () => {
    const r = await tools.get('browser_get_text')!.execute({ selector: '#missing' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('#missing');
  });

  it('缺参数 → ok:false', async () => {
    expect((await tools.get('browser_navigate')!.execute({})).ok).toBe(false);
    expect((await tools.get('browser_fill')!.execute({ selector: '#u' })).ok).toBe(false);
  });

  it('导航失败 → ok:false', async () => {
    driver.failNavigate('ERR_NAME_NOT_RESOLVED');
    const r = await tools.get('browser_navigate')!.execute({ url: 'http://nope.local' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('ERR_NAME_NOT_RESOLVED');
  });
});
