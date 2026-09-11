// packages/console-api/src/team/skill-distiller.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { EmployeeProfile, ModelGateway, TaskPackage } from '@ddw/runtime';
import type { EventStore } from '../stores/index.js';
import { newSkillId, SKILL_TYPES, type SkillStoreLike, type SkillRecord } from './skill-store.js';
import { extractJsonArray, replyToText } from './task-parser.js';

// 终审 I2：exec（shell 拼接）→ execFile 参数化执行——taskId 拼进 wsDir，shell 命令替换是注入面
const runGit = promisify(execFile);

/** 每任务蒸馏候选上限（spec §五：防刷库） */
export const MAX_CANDIDATES_PER_TASK = 2;

/**
 * 跨任务去重归一化口径（2026-09-08 遗留收尾）：trim + 去所有空白 + 小写——
 * 便宜可靠（不引入 embedding/外部依赖）；宁松勿严，只做归一化后精确匹配，不做包含匹配（防误杀新知识）。
 */
export function normalizeSkillText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/**
 * 候选与现有记录是否语义重复：标题或正文归一化后精确相等即判重复。
 * 判定范围由调用方圈定（distiller：同分类下 pending + approved，排除 rejected）。
 */
export function isDuplicateSkillCandidate(
  candidate: { name: string; content: string },
  existing: Pick<SkillRecord, 'name' | 'content'>,
): boolean {
  return normalizeSkillText(candidate.name) === normalizeSkillText(existing.name)
    || normalizeSkillText(candidate.content) === normalizeSkillText(existing.content);
}

export function buildDistillSystemPrompt(categoryIds: string[]): string {
  return [
    '你是研发知识蒸馏器。根据任务包、执行过程摘要与代码变更摘要，提炼可复用的经验沉淀为候选 Skill。',
    '只输出一个 ```json 围栏代码块，内容为 JSON 数组，每项：',
    '{ "categoryId": <分类id>, "type": "knowledge"|"constraint"|"asset", "name": <名称>, "description": <一句话说明>, "content": <markdown 正文> }',
    `categoryId 只能取：${categoryIds.join(', ') || '（无可用分类）'}。`,
    'type 语义：knowledge=可复用知识；constraint=开发约束（禁止/必须）；asset=可执行资产（此时附 assetFiles: [{ path, content }]，path 相对路径）。',
    '只提炼本次任务中真正可复用的内容；没有值得沉淀的就输出空数组 []。最多 2 条。',
  ].join('\n');
}

export interface DistillerDeps {
  gateway: ModelGateway;
  /** 存储抽象（存储企业化 Task 7）：File/Sql 双实现共同方法面，装配切换零改动 */
  skillStore: SkillStoreLike;
  events: EventStore;
  workspaceRoot: string;
  maxPerTask?: number;
}

/**
 * 任务完成蒸馏器（spec §五）：任务全部计划项 done 后异步触发——
 * 任务包 + 执行事件摘要 + git diff 摘要 → 模型产出候选 skill JSON → pending 入库 + 留痕。
 * 任何失败（模型/解析/校验）只事件留痕，不抛错不影响任务终态。
 */
export function createSkillDistiller(deps: DistillerDeps): (input: { task: TaskPackage; employee: EmployeeProfile }) => Promise<SkillRecord[]> {
  const maxPerTask = deps.maxPerTask ?? MAX_CANDIDATES_PER_TASK;
  return async ({ task, employee }) => {
    const wsDir = join(deps.workspaceRoot, employee.id, task.taskId.replaceAll('/', '_'));
    let diff = '';
    try {
      const { stdout } = await runGit('git', ['-C', wsDir, 'diff', 'HEAD', '--stat'], { timeout: 10_000 });
      diff = stdout.slice(0, 3000);
    } catch { /* 无 git 现场（faux 测试等）→ 空摘要继续 */ }
    const timeline = (await deps.events.list({ taskId: task.taskId }))
      .slice(-50)
      .map((e) => `[${e.type}] ${e.summary}`)
      .join('\n');

    const categories = await deps.skillStore.listCategories();
    const categoryIds = categories.map((c) => c.id);
    let raw: string;
    try {
      const stream = deps.gateway.streamFnFor('chat');
      const reply = await stream(deps.gateway.modelFor('chat'), {
        systemPrompt: buildDistillSystemPrompt(categoryIds),
        messages: [{
          role: 'user',
          content: [
            `任务包：${JSON.stringify({ taskId: task.taskId, title: task.title, role: task.role, plan: task.plan ?? [] })}`,
            `执行过程摘要：\n${timeline || '（无）'}`,
            `代码变更摘要：\n${diff || '（无）'}`,
          ].join('\n\n'),
          timestamp: Date.now(),
        }],
      } as never);
      raw = await replyToText(reply);
    } catch (e) {
      await deps.events.append({
        id: `distill-${task.taskId}-${randomUUID().slice(0, 8)}`, ts: Date.now(), taskId: task.taskId,
        employeeId: employee.id, type: 'report',
        summary: `Skill 沉淀失败（模型调用）：${e instanceof Error ? e.message : String(e)}`,
      });
      return [];
    }

    let candidates: Array<Record<string, unknown>>;
    try {
      candidates = extractJsonArray(raw) as Array<Record<string, unknown>>;
    } catch (e) {
      await deps.events.append({
        id: `distill-${task.taskId}-${randomUUID().slice(0, 8)}`, ts: Date.now(), taskId: task.taskId,
        employeeId: employee.id, type: 'report',
        summary: `Skill 沉淀失败（输出不可解析）：${e instanceof Error ? e.message : String(e)}`,
      });
      return [];
    }

    const created: SkillRecord[] = [];
    let dupSkipped = 0;
    for (const c of candidates) {
      if (created.length >= maxPerTask) break;
      const categoryId = String(c.categoryId ?? '');
      const type = String(c.type ?? '');
      const name = String(c.name ?? '').trim();
      const content = String(c.content ?? '').trim();
      // 逐条校验：分类/类型/非空——坏条目跳过不炸整批
      if (!categoryIds.includes(categoryId) || !SKILL_TYPES.has(type as never) || !name || !content) continue;
      // 跨任务去重（2026-09-08 遗留收尾）：同分类下已有 pending/approved 候选与本条同标题或同正文（归一化精确匹配）
      // → 跳过入库留痕「重复跳过」。rejected 不拦（人工否决后允许换说法重提）；范围含 approved——知识已生效注入链路，再入 pending 只是审查噪音
      const sameCategory = await deps.skillStore.listSkills({ categoryId });
      if (sameCategory.some((s) => s.status !== 'rejected' && isDuplicateSkillCandidate({ name, content }, s))) {
        dupSkipped += 1;
        continue;
      }
      const assetFiles = Array.isArray(c.assetFiles)
        ? (c.assetFiles as Array<{ path?: unknown; content?: unknown }>).map((f) => ({ path: String(f.path ?? ''), content: String(f.content ?? '') }))
        : undefined;
      const rec: SkillRecord = {
        id: newSkillId(), categoryId, name, description: String(c.description ?? ''),
        type: type as SkillRecord['type'], content,
        ...(assetFiles?.length ? { assetFiles } : {}),
        status: 'pending', source: `auto:${task.taskId}`, sourceTaskId: task.taskId, createdAt: Date.now(),
      };
      try {
        await deps.skillStore.upsertSkill(rec);
        created.push(rec);
      } catch { /* 单条入库失败（如 assetFiles 校验）跳过 */ }
    }

    await deps.events.append({
      id: `distill-${task.taskId}-${randomUUID().slice(0, 8)}`, ts: Date.now(), taskId: task.taskId,
      employeeId: employee.id, type: 'report',
      summary: created.length > 0
        ? `任务 ${task.taskId} 沉淀 ${created.length} 条候选 Skill 待审查${dupSkipped > 0 ? `，${dupSkipped} 条重复跳过` : ''}`
        : dupSkipped > 0
          ? `任务 ${task.taskId} 无可沉淀内容，${dupSkipped} 条重复跳过`
          : `任务 ${task.taskId} 无可沉淀内容`,
      payload: { ...(created.length > 0 ? { skillPending: true, count: created.length } : {}) },
    });
    return created;
  };
}
