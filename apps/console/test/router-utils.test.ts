import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'vue-router';
import { goBackOrHome } from '../src/router-utils.js';

const stateDesc = Object.getOwnPropertyDescriptor(window.history, 'state');

function mockHistoryState(state: unknown): void {
  Object.defineProperty(window.history, 'state', { value: state, configurable: true, writable: true });
}

afterEach(() => {
  if (stateDesc) Object.defineProperty(window.history, 'state', stateDesc);
});

function mockRouter(): Router {
  return { back: vi.fn(), push: vi.fn() } as unknown as Router;
}

describe('goBackOrHome（返回按钮兜底：直链/刷新无上一页时回首页）', () => {
  it('history.state.back 有值 → router.back()', () => {
    mockHistoryState({ back: '/task-center' });
    const router = mockRouter();
    goBackOrHome(router);
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('history.state 为空 → router.push(\'/\')', () => {
    mockHistoryState(null);
    const router = mockRouter();
    goBackOrHome(router);
    expect(router.push).toHaveBeenCalledWith('/');
    expect(router.back).not.toHaveBeenCalled();
  });

  it('history.state.back 为空值（直链进入）→ router.push(\'/\')', () => {
    mockHistoryState({ back: null, current: '/tasks/t-1' });
    const router = mockRouter();
    goBackOrHome(router);
    expect(router.push).toHaveBeenCalledWith('/');
    expect(router.back).not.toHaveBeenCalled();
  });
});
