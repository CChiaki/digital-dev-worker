/**
 * 盯梢三级放权策略（2026-09-11 用户需求）：等级单调放权梯度，
 * 由员工档案 supervision.level 驱动 run_cmd 白名单外命令的处理方式——
 *   shadow 盯梢期：task_check 节点申报挂审 + 白名单外命令挂审（叠加，最严）
 *   assisted 辅助期：task_check 申报即过只留痕，白名单外命令挂审
 *   trusted 信任期：申报即过，白名单外命令绕过白名单直接执行
 * 黑名单（sudo/rm -rf/公网外呼）与组合命令元字符在 ControlledBash 前置硬拒，
 * 三等级一致、人工放行也放不过——安全底线不参与放权。
 *
 * 未设置等级：保守挂审（approval=true）。节点闸门仍由 executor/plan-runner 各自
 * 严格判断 === 'shadow'（未设置不挂节点闸），本函数只管 bash 侧。
 */
export function bashPolicyFor(level?: 'shadow' | 'assisted' | 'trusted'): {
  /** true = 白名单外命令挂起等人工放行（makeBashApproval 链路） */
  approval: boolean;
  /** true = 跳过白名单校验直接执行（trusted 放权；黑名单/元字符/超时仍拦） */
  bypassWhitelist: boolean;
} {
  if (level === 'trusted') return { approval: false, bypassWhitelist: true };
  return { approval: true, bypassWhitelist: false };
}
