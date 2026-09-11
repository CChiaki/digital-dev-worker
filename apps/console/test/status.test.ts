import { describe, expect, it } from 'vitest';
import { TASK_STATUS_ZH, TASK_STATUS_TAG, zh, depsLabel } from '../src/status.js';

describe('状态展示统一（样式重构 spec §6）', () => {
  it('draft 显示「待发布」', () => {
    expect(zh(TASK_STATUS_ZH, 'draft')).toBe('待发布');
  });
  it('STATUS_TAG 统一色表：pending=warning / claimed=primary / running=primary / done=success / failed=danger / draft=info', () => {
    expect(TASK_STATUS_TAG).toEqual({
      draft: 'info', pending: 'warning', claimed: 'primary',
      running: 'primary', done: 'success', failed: 'danger',
    });
  });
});

describe('依赖状态文案单点（depsLabel）', () => {
  it('ready → 依赖就绪', () => {
    expect(depsLabel('ready')).toBe('依赖就绪');
  });
  it('blocked → 依赖阻断', () => {
    expect(depsLabel('blocked')).toBe('依赖阻断');
  });
  it('其它（缺省）→ 等待依赖', () => {
    expect(depsLabel('waiting')).toBe('等待依赖');
    expect(depsLabel('')).toBe('等待依赖');
  });
});
