/** 界面状态值中英映射：数据层（API/事件）保持英文原值，展示层统一在此转中文 */
export const TASK_STATUS_ZH: Record<string, string> = {
  draft: '待发布',
  pending: '待分派',
  claimed: '已接单',
  running: '执行中',
  done: '已完成',
  failed: '失败',
};

/** 任务状态 → el-tag 语义色（全站唯一色表，spec §6：各组件不得自建） */
export const TASK_STATUS_TAG: Record<string, 'info' | 'warning' | 'primary' | 'success' | 'danger'> = {
  draft: 'info',
  pending: 'warning',
  claimed: 'primary',
  running: 'primary',
  done: 'success',
  failed: 'danger',
};

export const EVENT_TYPE_ZH: Record<string, string> = {
  thinking: '思考',
  tool_call: '工具调用',
  task_check: '节点申报',
  dispatch: '调度',
  diff: '代码变更',
  report: '汇报',
  intervention: '人工复核',
  error: '错误',
  config_change: '配置变更', // 2026-09-11 后台写操作审计留痕（operator = API token 操作者）
};

export const SUPERVISION_ZH: Record<string, string> = {
  shadow: '盯梢期',
  assisted: '辅助期',
  trusted: '信任期',
};

/** 任务依赖状态 → 中文（TaskCenter 标签 / TaskDag 徽标共用，字面量单点） */
export const DEPS_STATE_ZH: Record<string, string> = {
  ready: '依赖就绪',
  blocked: '依赖阻断',
};
export const depsLabel = (s: string): string => DEPS_STATE_ZH[s] ?? '等待依赖';

export const zh = (map: Record<string, string>, value: string): string => map[value] ?? value;
