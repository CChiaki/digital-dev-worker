import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { TaskPackage } from '@ddw/runtime';

export interface PlanFormRow { id: string; kind: string; title: string; detail: string; verify: string; }
export interface TaskFormState {
  taskId: string; title: string; role: string;
  /** 指定员工 id（可选，2026-09-06）：点名分派，忽略 role；空/缺省不输出 */
  assignee?: string;
  repoUrl: string; branch: string;
  /** 前置任务 taskId 列表（创建对话框依赖任务多选，2026-09-06；空/缺省不输出） */
  dependsOn?: string[];
  plan: PlanFormRow[];
  /** 老包字段（tasks 等）非空时记录字段名——表单模式提交会丢失，反填时提示用户 */
  legacyFields?: string[];
}

/** 计划模式不支持的老包字段（表单序列化不输出，反填后提交会丢内容；baseBranch 按后端 schema 嵌在 repo 下；dependsOn 已转正不在此列） */
const LEGACY_FIELDS = ['tasks', 'apiDocs', 'codingStandard', 'reportChannel'] as const;
/** repo 内的遗留字段（TaskPackage.repo.baseBranch，表单不支持） */
const LEGACY_REPO_FIELDS = ['baseBranch'] as const;

/** 值非空：非 undefined/null、非空串、非空数组 */
function isNotEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}

/**
 * 生成不与既有 id 冲突的计划项 id：取 `t` 前缀后数字的最大序号+1
 * （无数字的 id 按行数计数兜底），空列表从 t1 起步。
 */
export function nextPlanId(ids: string[]): string {
  let maxSeq = 0;
  for (const id of ids) {
    const m = /^t(\d+)$/.exec(id.trim());
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }
  return `t${Math.max(maxSeq + 1, ids.length + 1)}`;
}

const clean = (s: string): string | undefined => (s.trim() ? s.trim() : undefined);

/** 表单 → 任务包 yaml（空 kind/verify 不输出，后端缺省 dev） */
export function planFormToYaml(form: TaskFormState): string {
  const doc: Record<string, unknown> = {
    taskId: form.taskId.trim(),
    title: form.title.trim(),
    repo: { url: form.repoUrl.trim(), branch: form.branch.trim() },
    plan: form.plan
      .filter((r) => r.id.trim() && r.title.trim())
      .map((r) => ({
        id: r.id.trim(),
        ...(clean(r.kind) ? { kind: clean(r.kind) } : {}),
        title: r.title.trim(),
        detail: r.detail.trim(),
        ...(clean(r.verify) ? { verify: clean(r.verify) } : {}),
      })),
    ...(clean(form.role) ? { role: clean(form.role) } : {}),
    ...(clean(form.assignee ?? '') ? { assignee: clean(form.assignee ?? '') } : {}),
    ...(form.dependsOn?.length ? { dependsOn: form.dependsOn } : {}),
  };
  return stringifyYaml(doc);
}

/**
 * 任务包 → yaml（编辑回填，2026-09-06 draft 修改）：不能直接 stringify(pkg)——
 * 计划模式包的 tasks 为 []，原样输出会被后端 parseTaskPackage 判为 plan/tasks 互斥冲突。
 * 空值可选字段不输出，plan 项空 kind/verify 不输出，保证回填 yaml 可原样再提交。
 */
export function pkgToYaml(pkg: TaskPackage): string {
  const doc: Record<string, unknown> = {
    taskId: pkg.taskId,
    title: pkg.title,
    repo: {
      url: pkg.repo.url,
      branch: pkg.repo.branch,
      ...(pkg.repo.baseBranch ? { baseBranch: pkg.repo.baseBranch } : {}),
    },
    ...(pkg.plan?.length
      ? {
          plan: pkg.plan.map((p) => ({
            id: p.id,
            ...(p.kind ? { kind: p.kind } : {}),
            title: p.title,
            detail: p.detail,
            ...(p.verify ? { verify: p.verify } : {}),
          })),
        }
      : pkg.tasks.length
        ? { tasks: pkg.tasks }
        : {}),
    ...(pkg.role ? { role: pkg.role } : {}),
    ...(pkg.assignee ? { assignee: pkg.assignee } : {}),
    ...(pkg.dependsOn?.length ? { dependsOn: pkg.dependsOn } : {}),
    ...(pkg.apiDocs ? { apiDocs: pkg.apiDocs } : {}),
    ...(pkg.codingStandard ? { codingStandard: pkg.codingStandard } : {}),
    ...(pkg.reportChannel ? { reportChannel: pkg.reportChannel } : {}),
  };
  return stringifyYaml(doc);
}

/** 任务包 yaml → 表单（不含 plan 的老包 plan: []，仍以 yaml 模式提交零损失） */
export function yamlToPlanForm(yaml: string): TaskFormState {
  const raw = parseYaml(yaml) as Record<string, unknown>;
  const repo = (raw?.['repo'] ?? {}) as Record<string, unknown>;
  const plan = Array.isArray(raw?.['plan']) ? (raw['plan'] as Record<string, unknown>[]) : [];
  // dependsOn 已转正（表单支持）：字符串数组解析，非字符串项过滤，缺省空数组
  const dependsOn = Array.isArray(raw?.['dependsOn'])
    ? (raw['dependsOn'] as unknown[]).filter((d): d is string => typeof d === 'string')
    : [];
  // 老包字段防丢：非空即记录，供 fillFromYaml 提示「切表单模式会丢字段」
  // （baseBranch 按后端 schema 嵌在 repo 下，顶层写法后端不读）
  const legacyFields = [
    ...LEGACY_FIELDS.filter((f) => isNotEmpty(raw?.[f])),
    ...LEGACY_REPO_FIELDS.filter((f) => isNotEmpty(repo?.[f])),
  ];
  const assignee = clean(String(raw?.['assignee'] ?? ''));
  return {
    taskId: String(raw?.['taskId'] ?? ''),
    title: String(raw?.['title'] ?? ''),
    role: String(raw?.['role'] ?? ''),
    ...(assignee ? { assignee } : {}),
    repoUrl: String(repo['url'] ?? ''),
    branch: String(repo['branch'] ?? ''),
    dependsOn,
    plan: plan.map((p) => ({
      id: String(p['id'] ?? ''),
      kind: String(p['kind'] ?? ''),
      title: String(p['title'] ?? ''),
      detail: String(p['detail'] ?? ''),
      verify: String(p['verify'] ?? ''),
    })),
    ...(legacyFields.length > 0 ? { legacyFields } : {}),
  };
}
