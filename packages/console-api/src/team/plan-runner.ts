import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  createTaskCheckTool,
  buildPlanItemInstruction,
  type AgentEvent, type AgentFactory, type CheckGate, type EmployeeOutcome, type EmployeeProfile,
  type EventBus, type ModelGateway, type PlanItem, type PlanProgress, type TaskPackage, type ToolRegistry,
} from '@ddw/runtime';
import { assembleDefaultRuntime } from './executor.js';
import { appendSkillContext, materializeSkillAssets } from './skill-injection.js';
import type { SkillRecord } from './skill-store.js';
import type { CapabilityDef } from './capabilities.js';
import type { DeployConfig } from './runtime-config.js';

const runCmd = promisify(exec);

export interface PlanRunInput {
  pkg: TaskPackage & { plan: PlanItem[] };
  employee: EmployeeProfile;
  workspaceDir: string;
  sessionsRoot: string;
  gateway: ModelGateway;
  events: EventBus;
  checkGate?: (taskId: string) => CheckGate;
  agentFactory?: AgentFactory;
  /** 每项工具集：按 kind 查注册表后组装（executor/worker 各自注入 base 配置） */
  toolsForItem: (item: PlanItem, mcp: string[], builtin: string[]) => ToolRegistry;
  /** 能力注册表 provider：启动校验 + 每项执行前重新取值
   *  （spec §5 运行中被改语义：inproc 模式每项执行前查表即时生效；fork 模式为分派时快照，provider 恒返回同一快照） */
  capabilities: () => Promise<CapabilityDef[]>;
  /** deploy 配置（devops 项可用性校验用） */
  deploy?: DeployConfig;
  forge?: unknown; // 仅存在性判断（commit 项校验）
  /** 续跑起点：已有进度（done 项跳过） */
  progress?: PlanProgress[];
  /** Skill 注入清单（2026-09-06）：分派时按员工分类过滤后的 approved 清单；缺省 = 不注入 */
  skills?: SkillRecord[];
  /** 每任务最大对话轮数（yaml maxTurns；缺省 EmployeeRuntime 内置 40） */
  maxTurns?: number;
  /** 每项失败自动重试次数（2026-09-11 P2 产品批 yaml retryPerItem；缺省 0 = 失败即停保持现状）。
   *  重试经事件留痕；耗尽重试才 failed 即停（后续项 skipped） */
  retryPerItem?: number;
}

const kindOf = (item: PlanItem): string => item.kind ?? 'dev';

/** 启动校验：每项 kind 已注册且启用；mcp 依赖的运行时配置在场（fail fast，不带病执行） */
async function validatePlan(items: PlanItem[], capabilities: () => Promise<CapabilityDef[]>, input: PlanRunInput): Promise<void> {
  const defs = await capabilities();
  for (const item of items) {
    const kind = kindOf(item);
    const def = defs.find((c) => c.kind === kind);
    if (!def || !def.enabled) {
      throw new Error(`任务项 ${item.id}.kind='${kind}' 未注册或已停用（能力管理中登记后方可使用）`);
    }
    if (def.tools.mcp.includes('forge') && !input.forge) {
      throw new Error(`能力 ${kind} 依赖 forge 工具包，但运行时未配置 forge 段（代码托管协作）`);
    }
    if (def.tools.mcp.includes('deploy') && !input.deploy) {
      throw new Error(`能力 ${kind} 依赖 deploy 工具包，但运行时未配置 deploy 段（发布部署）`);
    }
  }
}

/**
 * 计划执行器（2026-09-05，spec 任务计划模式）：同一员工同一会话逐项驱动。
 * 每项：kind→工具集 → 员工执行 + task_check 申报 → verify 命令执行器亲自跑 →
 * 通过记 done 继续 / 失败记 failed 即停（后续 skipped）。
 * 返回 outcome 携带 planProgress/failedItemId（调度器 finish 落库）。
 */
export async function runTaskPlan(input: PlanRunInput): Promise<EmployeeOutcome> {
  const items = input.pkg.plan;
  await validatePlan(items, input.capabilities, input);
  // Skill 注入（2026-09-06）：asset 落盘一次（整计划共用），文档类每项追加指令
  const skills = input.skills ?? [];
  if (skills.some((s) => s.type === 'asset')) {
    await materializeSkillAssets(input.workspaceDir, skills);
  }
  const done = new Map<string, PlanProgress>();
  for (const p of input.progress ?? []) done.set(p.itemId, p);

  const total = items.length;
  const progress: PlanProgress[] = items.map((it) => done.get(it.id) ?? { itemId: it.id, kind: kindOf(it), title: it.title, status: 'skipped' });
  const firstPending = items.findIndex((it) => done.get(it.id)?.status !== 'done');

  await input.events.emit({
    id: randomUUID(), ts: Date.now(), taskId: input.pkg.taskId, employeeId: input.employee.id,
    type: 'report', summary: `计划执行：共 ${total} 项${firstPending > 0 ? `（续跑，从第 ${firstPending + 1} 项起）` : ''}`,
    payload: { plan: { phase: 'start' } },
  });

  // run() vs resumeWith：首项且非续跑走 run()（task_check 申报 + supervision 留痕），
  // 其余（首项为续跑 / 后续各项）走 resumeWith（同一会话上下文延续）
  const useResume = (i: number): boolean => firstPending > 0 || i > 0;

  // token 用量任务级累计（2026-09-11 P2 产品批）：每项新建 runtime 实例，单实例账本只记当项——
  // 任务总量在计划执行器层逐项累加；calls 为 0（无模型调用/faux 零用量）不随 outcome 下发
  const usage = { input: 0, output: 0, calls: 0 };
  const usageOf = (): { input: number; output: number; calls: number } | undefined =>
    usage.calls > 0 ? { ...usage } : undefined;

  // 失败即停统一出口：本项 failed、后续 skipped、事件留痕（执行失败与运行中查表失败共用）
  const stopAt = async (i: number, item: PlanItem, reason: string): Promise<EmployeeOutcome> => {
    progress[i]!.status = 'failed';
    await input.events.emit({
      id: randomUUID(), ts: Date.now(), taskId: input.pkg.taskId, employeeId: input.employee.id,
      type: 'report', summary: `计划项 ${i + 1}/${total} 失败：${item.title}（${reason}）`,
      payload: { plan: { phase: 'failed', itemId: item.id, reason } },
    });
    for (let j = i + 1; j < total; j++) progress[j]!.status = 'skipped';
    return {
      status: 'done', reply: `计划停在第 ${i + 1} 项（${item.title}）：${reason}`, turns: 0,
      planProgress: progress, failedItemId: item.id,
      ...(usageOf() ? { tokenUsage: usageOf() } : {}),
    };
  };

  for (let i = firstPending; i < total; i++) {
    const item = items[i]!;
    const kind = kindOf(item);
    // 每项执行前重新查注册表（spec §5：运行中注册表被改 → 该项执行时报错、按失败即停；
    // fork 模式 capabilities 为分派时快照（IPC JSON），provider 恒返回同一快照，行为不变）
    const def = (await input.capabilities()).find((c) => c.kind === kind);
    if (!def || !def.enabled) {
      return stopAt(i, item, `计划项 ${item.id}.kind='${kind}' 未注册或已停用（能力管理中登记后方可使用）`);
    }
    await input.events.emit({
      id: randomUUID(), ts: Date.now(), taskId: input.pkg.taskId, employeeId: input.employee.id,
      type: 'report', summary: `计划项 ${i + 1}/${total} 开始：${item.title}`,
      payload: { plan: { phase: 'start', itemId: item.id, kind } },
    });

    const doneSummary = progress
      .filter((p) => p.status === 'done')
      .map((p) => `${p.itemId} ${p.title}：已完成`);
    const baseInstruction = buildPlanItemInstruction(input.pkg, item, i, total, doneSummary);
    const instruction = skills.length > 0 ? appendSkillContext(baseInstruction, skills) : baseInstruction;

    // 每项失败自动重试（2026-09-11 P2 产品批 yaml retryPerItem）：maxAttempts = 1 + 重试次数。
    // 重试经 resumeWith（session 已含失败上下文，模型可见失败原因自纠偏）并留痕 retry 事件；
    // 耗尽重试才 failed 即停。缺省 retryPerItem=0 → 单次执行，行为与改造前完全一致
    const maxAttempts = 1 + (input.retryPerItem ?? 0);
    let failed = false;
    let failReason = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      failed = false;
      failReason = '';
      // 每次尝试新 runtime 实例 + 新工具集（重试时注册表/技能变更同样生效）；
      // 首次尝试按 useResume 判定，重试必经 resumeWith（session 已在场）
      const runtime = assembleDefaultRuntime({
        gateway: input.gateway,
        events: input.events,
        tools: input.toolsForItem(item, def.tools.mcp, def.tools.builtin),
        sessionsRoot: input.sessionsRoot,
        employee: input.employee,
        taskId: input.pkg.taskId,
        ...(input.checkGate ? { checkGate: input.checkGate } : {}),
        ...(input.agentFactory ? { agentFactory: input.agentFactory } : {}),
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
      });
      // task_check 申报工具：仅 resumeWith 路径需要（首项 run() 内部按 items 自行注入，
      // runtime.run 时构造 checkTool 纯属无谓开销 + shadow 级多包一层 gate）
      const resume = useResume(i) || attempt > 1;
      const checkTool = resume
        ? createTaskCheckTool({
            emit: (e) => input.events.emit({ id: randomUUID(), ts: Date.now(), taskId: input.pkg.taskId, employeeId: input.employee.id, ...e }),
            items: [item],
            ...(input.checkGate && input.employee.supervision?.level === 'shadow' ? { gate: input.checkGate(input.pkg.taskId) } : {}),
          })
        : undefined;

      // 关键工具结果客观核对（spec §3.1/§5）：mcp 工具（deploy_/gitea_/gitlab_ 前缀）调用失败
      // 不取决于员工申报——执行器监听 tool_call 事件，按每工具「最后一次调用状态」判失败：
      // 被拒后重试成功不算账（2026-09-05 实战：整包提交超输出上限被拒 → 拆单重提成功，不得误杀），
      // 成功后再失败仍拦截。run_cmd/bash 失败是 dev/test 日常语义，不在核对范围。项结束即摘除 collector。
      const toolLastFailed = new Map<string, boolean>();
      // 盯梢期申报强制（2026-09-11 事故修复）：shadow 级 task_check 申报是人工放行闸门的唯一入口，
      // 模型未申报就结束 = 闸门被整个绕过（真实事故：模型 400 假 done，5 项全过、0 人工节点）。
      // 监听 tool_call 事件确认申报真实发生——被人工驳回的申报（isError=true）不算数，缺失即本项失败
      let sawCheck = false;
      const onToolCall = (e: AgentEvent): void => {
        if (e.summary === 'task_check' && !(e.payload as { isError?: boolean } | undefined)?.isError) sawCheck = true;
        if (!/^(deploy_|gitea_|gitlab_)/.test(e.summary ?? '')) return;
        const p = e.payload as { isError?: boolean } | undefined;
        toolLastFailed.set(e.summary, !!p?.isError);
      };
      input.events.on('tool_call', onToolCall);
      try {
        const outcome = resume
          ? await runtime.resumeWith(input.pkg.taskId, instruction, checkTool!)
          : await runtime.run({ taskId: input.pkg.taskId, instruction, items: [item] });
        // 当项用量入任务总账（实例账本只记当项——见上方 usage 注释）；重试同样入账（诚实成本）
        if (outcome.tokenUsage) {
          usage.input += outcome.tokenUsage.input;
          usage.output += outcome.tokenUsage.output;
          usage.calls += outcome.tokenUsage.calls;
        }
        // 撞轮次上限即失败：短路 verify（员工没做完，跑验证纯浪费且会覆盖 failReason）；
        // reason 带上生效上限值（turns 到达上限即停 → 恰等于 maxTurns）——运维侧可据此确认
        // yaml maxTurns 配置已生效（2026-09-10：曾因不带值无法区分「40 缺省」与「100 已配置」）
        if (outcome.status === 'max_turns') {
          failed = true;
          failReason = `达到轮次上限（max_turns=${outcome.turns}）`;
        } else if (outcome.status === 'error') {
          // 模型失败收尾（2026-09-11 事故修复）：runtime 已把 pi 的 stopReason=error/aborted
          // （空 assistant 消息，不抛异常）映射为 error outcome——同样短路 verify，原因即错误原文
          failed = true;
          failReason = outcome.reply;
        } else if (item.verify) {
          // verify：员工申报通过后执行器亲自跑（客观门禁，模型骗不过）
          try {
            await runCmd(item.verify, { cwd: input.workspaceDir, timeout: 10 * 60_000 });
          } catch (e) {
            failed = true;
            failReason = `验证命令失败: ${item.verify} — ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`;
          }
        }
      } catch (e) {
        failed = true;
        failReason = `执行异常: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        input.events.off('tool_call', onToolCall);
      }
      const lastFailedTools = [...toolLastFailed.entries()].filter(([, bad]) => bad).map(([name]) => name);
      if (!failed && lastFailedTools.length > 0) {
        failed = true;
        failReason = `关键工具调用失败: ${lastFailedTools.join(', ')}（执行器核对工具结果，不采信申报）`;
      }
      // 盯梢期申报强制（2026-09-11 事故修复）：shadow 级未申报 task_check 即结束 = 放行闸门被绕过，
      // 本项判失败（assisted/trusted 申报仅为留痕，无人工环节，不强制——保持既有语义零回归）
      if (!failed && input.employee.supervision?.level === 'shadow' && !sawCheck) {
        failed = true;
        failReason = '盯梢期未申报 task_check 即结束（人工放行闸门被绕过）';
      }
      if (!failed) break; // 本项通过：进入下一项

      // 本尝试失败且尚有重试额度：留痕后重跑（耗尽额度静默落 stopAt，其留痕由 stopAt 统一承担）
      if (attempt < maxAttempts) {
        await input.events.emit({
          id: randomUUID(), ts: Date.now(), taskId: input.pkg.taskId, employeeId: input.employee.id,
          type: 'report',
          summary: `计划项 ${i + 1}/${total} 第 ${attempt} 次执行失败：${item.title}（${failReason}），自动重试（${attempt}/${maxAttempts - 1}）`,
          payload: { plan: { phase: 'retry', itemId: item.id, attempt, reason: failReason } },
        });
      }
    }

    const entry = progress[i]!;
    if (failed) return stopAt(i, item, failReason);
    entry.status = 'done';
    await input.events.emit({
      id: randomUUID(), ts: Date.now(), taskId: input.pkg.taskId, employeeId: input.employee.id,
      type: 'report', summary: `计划项 ${i + 1}/${total} 完成：${item.title}`,
      payload: { plan: { phase: 'done', itemId: item.id } },
    });
  }

  return {
    status: 'done', reply: `计划全部完成（${total} 项）`, turns: 0, planProgress: progress,
    ...(usageOf() ? { tokenUsage: usageOf() } : {}),
  };
}
