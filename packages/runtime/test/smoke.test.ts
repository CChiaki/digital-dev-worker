import { describe, it, expect } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';

describe('runtime 冒烟', () => {
  it('pi 依赖可用（Agent 构造成功）', () => {
    expect(Agent).toBeTypeOf('function');
  });
});
