import { describe, it, expect } from 'vitest';
import { bashPolicyFor } from '../src/team/supervision-policy.js';

/** 盯梢三级放权策略（2026-09-11 用户需求）：等级 → run_cmd 策略映射，
 *  executor（inproc 计划分支）/ pipeline toolsFor（inproc 非计划）/ worker（fork）三处消费 */
describe('bashPolicyFor（盯梢三级等级放权，2026-09-11）', () => {
  it('shadow：白名单外命令挂审（与节点申报叠加，不 bypass）', () => {
    expect(bashPolicyFor('shadow')).toEqual({ approval: true, bypassWhitelist: false });
  });

  it('assisted：白名单外命令挂审（节点申报只留痕不阻塞）', () => {
    expect(bashPolicyFor('assisted')).toEqual({ approval: true, bypassWhitelist: false });
  });

  it('trusted：不挂审、绕过白名单直接执行（黑名单/组合命令仍在 ControlledBash 前置硬拒）', () => {
    expect(bashPolicyFor('trusted')).toEqual({ approval: false, bypassWhitelist: true });
  });

  it('未设置等级：保守挂审（与节点闸门 === shadow 严格判断保持同样的缺省取向）', () => {
    expect(bashPolicyFor(undefined)).toEqual({ approval: true, bypassWhitelist: false });
  });
});
