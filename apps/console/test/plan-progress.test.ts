import { describe, it, expect, afterEach } from 'vitest';
import PlanProgress from '../src/components/PlanProgress.vue';
import { mountWithEP } from './mount-helper.js';
import type { PlanItem } from '@ddw/runtime';
import type { PlanProgress as PlanProgressItem } from '../src/api.js';

const PROGRESS: PlanProgressItem[] = [
  { itemId: 't1', kind: 'dev', title: '开发登录接口', status: 'done' },
  { itemId: 't2', kind: 'test', title: '联调验证', status: 'failed' },
  { itemId: 't3', kind: 'commit', title: '提交建 MR', status: 'skipped' },
];

const PLAN_ITEMS: PlanItem[] = [
  { id: 't1', kind: 'dev', title: '开发登录接口', detail: '实现 POST /login 接口', verify: 'npm test' },
  { id: 't2', kind: 'test', title: '联调验证', detail: '跑通登录全链路' },
  { id: 't3', kind: 'commit', title: '提交建 MR', detail: '提交到 dev 分支' },
];

let wrapper: ReturnType<typeof mountWithEP> | undefined;
afterEach(() => wrapper?.unmount());

describe('PlanProgress 计划进度（2026-09-05）', () => {
  it('逐项展示：done=已完成、failed=失败、skipped=待执行', () => {
    const wrapper = mountWithEP(PlanProgress, { props: { progress: PROGRESS, failedItemId: 't2' } });
    expect(wrapper.find('[data-test="plan-item-t1"]').text()).toContain('已完成');
    expect(wrapper.find('[data-test="plan-item-t2"]').text()).toContain('失败');
    expect(wrapper.find('[data-test="plan-item-t3"]').text()).toContain('待执行');
  });

  it('失败停点高亮：failedItemId 项标记 failed-item', () => {
    const wrapper = mountWithEP(PlanProgress, { props: { progress: PROGRESS, failedItemId: 't2' } });
    expect(wrapper.find('[data-test="plan-item-t2"]').classes()).toContain('failed-item');
    expect(wrapper.find('[data-test="plan-item-t1"]').classes()).not.toContain('failed-item');
  });

  it('无进度（非计划任务）不渲染', () => {
    const wrapper = mountWithEP(PlanProgress, { props: {} });
    expect(wrapper.find('[data-test="plan-progress"]').exists()).toBe(false);
  });

  it('悬浮 tooltip 展示任务包明细：要求 + 验收命令（persistent 挂 body）', () => {
    wrapper = mountWithEP(PlanProgress, {
      props: { progress: PROGRESS, planItems: PLAN_ITEMS },
      attachTo: document.body,
    });
    // EP persistent popper 在 jsdom 下对 content 做多份渲染（transition 克隆），按内容断言而非份数
    const text = [...document.body.querySelectorAll('[data-test="plan-tip"]')].map((t) => t.textContent).join('\n');
    expect(text).toContain('实现 POST /login 接口');
    expect(text).toContain('验收命令：');
    expect(text).toContain('npm test');
    // 无 verify 的项不出「验收命令」行：t2 明细后紧跟的是别的项标题而非验收行
    expect(text).not.toContain('跑通登录全链路验收命令');
  });

  it('无 planItems 明细容错：tooltip 显示占位文案而非报错', () => {
    wrapper = mountWithEP(PlanProgress, { props: { progress: PROGRESS }, attachTo: document.body });
    const text = [...document.body.querySelectorAll('[data-test="plan-tip"]')].map((t) => t.textContent).join('\n');
    expect(text).toContain('（任务包无该项明细）');
  });
});
