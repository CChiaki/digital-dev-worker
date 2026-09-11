import { describe, it, expect } from 'vitest';
import TaskDag from '../src/components/TaskDag.vue';
import type { TaskSummary } from '../src/api.js';
import { mountWithEP } from './mount-helper.js';

/**
 * P12-T1 编排视图：任务依赖 DAG → 拓扑分层列。
 * 分层正确性：无依赖第 1 层 / 多级链逐层 / 并行同层 / blocked（上游缺失）仍可见。
 */

const task = (taskId: string, dependsOn?: string[], status: TaskSummary['status'] = 'pending'): TaskSummary => ({
  taskId,
  title: `任务 ${taskId}`,
  status,
  hasResult: false,
  ...(dependsOn ? { dependsOn } : {}),
});

const levelTasks = (wrapper: ReturnType<typeof mountWithEP>, i: number): string[] =>
  wrapper.findAll('[data-test="dag-level"]')[i]!
    .findAll('[data-test^="dag-card-"]')
    .map((c) => c.attributes('data-test')!.replace('dag-card-', ''));

describe('TaskDag 依赖分层视图', () => {
  it('无依赖任务排第 1 层；多级依赖链逐层排布（A→B→C 三层）', () => {
    const wrapper = mountWithEP(TaskDag, { props: { tasks: [task('C', ['B']), task('B', ['A']), task('A')] } });
    const levels = wrapper.findAll('[data-test="dag-level"]');
    expect(levels).toHaveLength(3);
    expect(levelTasks(wrapper, 0)).toEqual(['A']);
    expect(levelTasks(wrapper, 1)).toEqual(['B']);
    expect(levelTasks(wrapper, 2)).toEqual(['C']);
  });

  it('并行无依赖任务同层；分叉汇聚（A→B、A→C）归入同一层', () => {
    const wrapper = mountWithEP(TaskDag, { props: { tasks: [task('B', ['A']), task('C', ['A']), task('A'), task('D')] } });
    expect(levelTasks(wrapper, 0)).toEqual(['A', 'D']);
    expect(levelTasks(wrapper, 1)).toEqual(['B', 'C']);
  });

  it('blocked（依赖缺失/上游失败）任务仍可见（不隐藏），进入缺失依赖的下一层', () => {
    const wrapper = mountWithEP(TaskDag, {
      props: { tasks: [task('A', undefined, 'failed'), task('B', ['A'])] }, // B 的上游 A failed → blocked
    });
    const cards = wrapper.findAll('[data-test^="dag-card-"]');
    expect(cards.map((c) => c.attributes('data-test'))).toContain('dag-card-B');
    expect(levelTasks(wrapper, 1)).toEqual(['B']);
  });

  it('卡片点击 emit open(taskId)；依赖行内可见', async () => {
    const wrapper = mountWithEP(TaskDag, { props: { tasks: [task('B', ['A'])] } });
    await wrapper.find('[data-test="dag-card-B"]').trigger('click');
    expect(wrapper.emitted('open')).toEqual([['B']]);
    expect(wrapper.find('[data-test="dag-card-B"]').text()).toContain('依赖 A');
  });

  it('依赖环任务统一沉入尾部「依赖环」列（防御环依赖，不入常规层、不出巨号层号）', () => {
    const wrapper = mountWithEP(TaskDag, { props: { tasks: [task('A', ['B']), task('B', ['A']), task('C')] } });
    const levels = wrapper.findAll('[data-test="dag-level"]');
    expect(levelTasks(wrapper, 0)).toEqual(['C']);
    // A、B 互相依赖成环 → 与被环阻塞者同入最后一列，标注「依赖环」
    expect(levelTasks(wrapper, levels.length - 1)).toEqual(['A', 'B']);
    expect(levels[levels.length - 1]!.text()).toContain('依赖环');
    // 被环阻塞的下游任务也沉入同列
    const withDownstream = mountWithEP(TaskDag, { props: { tasks: [task('A', ['B']), task('B', ['A']), task('D', ['A'])] } });
    const dsLevels = withDownstream.findAll('[data-test="dag-level"]');
    expect(dsLevels).toHaveLength(1); // 无常规层，全部沉尾列
    expect(levelTasks(withDownstream, 0)).toEqual(['A', 'B', 'D']);
  });

  it('depsState=blocked 的卡片带「依赖阻断」红色徽标（阻断一眼可见）', () => {
    const wrapper = mountWithEP(TaskDag, {
      props: { tasks: [{ ...task('B', ['A']), depsState: 'blocked' } as TaskSummary] },
    });
    expect(wrapper.find('[data-test="deps-blocked"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="deps-blocked"]').text()).toBe('依赖阻断');
  });

  it('空任务列表：不渲染任何分层', () => {
    const wrapper = mountWithEP(TaskDag, { props: { tasks: [] } });
    expect(wrapper.findAll('[data-test="dag-level"]')).toHaveLength(0);
  });
});
