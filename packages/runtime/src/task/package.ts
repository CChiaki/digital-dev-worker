import { parse as parseYaml } from 'yaml';

/** 开发任务：细化到文件 */
export interface DevTask {
  id: string;
  title: string;
  files: string[];
  requirement: string;
  acceptance: string[];
}

/** 计划项（任务计划模式，2026-09-05）：逐项驱动执行，kind 查能力注册表（缺省 dev） */
export interface PlanItem {
  id: string;
  kind?: string;
  title: string;
  detail: string;
  /** 可选验证命令：执行器在员工申报后亲自运行，退出码 0 该项才 done */
  verify?: string;
}

/** 任务包：控制台固化后数字员工接单的最小数据单元（spec 2.5 任务控制台） */
export interface TaskPackage {
  taskId: string;
  title: string;
  repo: {
    url: string;
    branch: string;
    baseBranch?: string;
  };
  tasks: DevTask[];
  /** 任务计划（可选，与 tasks 互斥）：有 plan 走计划执行器逐项驱动 */
  plan?: PlanItem[];
  /** 岗位要求（二期班组编排）：只分派给主岗 role 精确匹配的员工（2026-09-08 遗留收尾 T2 对齐 ManagedRoster，skills 集合匹配退役）；缺省任意员工可接 */
  role?: string;
  /** 依赖的任务包 taskId（二期班组编排，spec 4.2 包级依赖）：全部 done 才可分派 */
  dependsOn?: string[];
  /** 指定员工 id（可选，2026-09-06）：分派点名该员工，忽略 role 匹配；员工忙则等其完成 */
  assignee?: string;
  /** 接口文档地址（联调依据） */
  apiDocs?: string;
  /** 编码规范说明（注入任务简报约束写码行为） */
  codingStandard?: string;
  /** 完成后的汇报渠道（MR/Jira 单号约定等） */
  reportChannel?: string;
}

function requireField(obj: Record<string, unknown>, path: string): unknown {
  const v = obj[path];
  if (v === undefined || v === null || v === '') {
    throw new Error(`任务包缺少必填字段: ${path}`);
  }
  return v;
}

/** 任务包 yaml 解析 + 校验。错误信息面向模型/人可读（回灌后可自纠）。 */
export function parseTaskPackage(yamlText: string): TaskPackage {
  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(yamlText) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`任务包 yaml 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('任务包 yaml 解析失败: 内容为空');
  }

  const taskId = requireField(raw, 'taskId') as string;
  const title = requireField(raw, 'title') as string;
  const repo = requireField(raw, 'repo') as Record<string, unknown>;
  // 任务计划（2026-09-05）：plan 与 tasks 互斥；有 plan 时 tasks 可省略
  let plan: PlanItem[] | undefined;
  let tasks: DevTask[] = [];
  if (raw['plan'] !== undefined && raw['plan'] !== null) {
    if (raw['tasks'] !== undefined && raw['tasks'] !== null) {
      throw new Error('任务包字段冲突: plan 与 tasks 互斥（计划模式用 plan，勿再写 tasks）');
    }
    if (!Array.isArray(raw['plan']) || raw['plan'].length === 0) {
      throw new Error('任务包字段类型错误: plan 应为非空数组');
    }
    const seen = new Set<string>();
    plan = (raw['plan'] as Record<string, unknown>[]).map((p) => {
      const id = requireField(p, 'id') as string;
      for (const k of ['title', 'detail'] as const) {
        const v = p[k];
        if (v === undefined || v === null || v === '') {
          throw new Error(`任务包缺少必填字段: plan[${id}].${k}`);
        }
      }
      if (seen.has(id)) throw new Error(`任务包字段错误: plan 项 id 重复: ${id}`);
      seen.add(id);
      return {
        id,
        ...(p['kind'] !== undefined && p['kind'] !== null && p['kind'] !== '' ? { kind: p['kind'] as string } : {}),
        title: p['title'] as string,
        detail: p['detail'] as string,
        ...(p['verify'] ? { verify: p['verify'] as string } : {}),
      };
    });
  }

  if (!plan) {
    const tasksRaw = requireField(raw, 'tasks') as Record<string, unknown>[];
    if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
      throw new Error('任务包缺少必填字段: tasks（至少一个开发任务）');
    }

    tasks = tasksRaw.map((t) => {
      const id = requireField(t, 'id') as string;
      const sub = (key: string): unknown => {
        const v = t[key];
        if (v === undefined || v === null || v === '') {
          throw new Error(`任务包缺少必填字段: tasks[${id}].${key}`);
        }
        return v;
      };
      return {
        id,
        title: sub('title') as string,
        files: sub('files') as string[],
        requirement: sub('requirement') as string,
        acceptance: sub('acceptance') as string[],
      };
    });
  }

  const repoUrl = repo['url'];
  const repoBranch = repo['branch'];
  if (!repoUrl || !repoBranch) {
    throw new Error(`任务包缺少必填字段: repo.${!repoUrl ? 'url' : 'branch'}`);
  }

  // 二期班组编排字段（可选）：岗位要求 + 包级依赖
  let role: string | undefined;
  if (raw['role'] !== undefined && raw['role'] !== null && raw['role'] !== '') {
    if (typeof raw['role'] !== 'string') throw new Error('任务包字段类型错误: role 应为字符串（岗位名）');
    role = raw['role'];
  }
  let dependsOn: string[] | undefined;
  if (raw['dependsOn'] !== undefined && raw['dependsOn'] !== null) {
    if (!Array.isArray(raw['dependsOn']) || raw['dependsOn'].length === 0) {
      throw new Error('任务包字段类型错误: dependsOn 应为非空 taskId 数组（无依赖时省略该字段）');
    }
    for (const dep of raw['dependsOn']) {
      if (typeof dep !== 'string' || !dep.trim()) {
        throw new Error(`任务包字段类型错误: dependsOn 含非法元素（应为 taskId 字符串），得到: ${String(dep)}`);
      }
    }
    dependsOn = raw['dependsOn'] as string[];
  }
  // 指定员工（2026-09-06，可选）：点名分派；空串视为未指定，非字符串可读报错
  let assignee: string | undefined;
  if (raw['assignee'] !== undefined && raw['assignee'] !== null && raw['assignee'] !== '') {
    if (typeof raw['assignee'] !== 'string' || !raw['assignee'].trim()) {
      throw new Error('任务包字段类型错误: assignee 应为字符串（员工 id）');
    }
    assignee = raw['assignee'];
  }

  return {
    taskId,
    title,
    repo: {
      url: repoUrl as string,
      branch: repoBranch as string,
      ...(repo['baseBranch'] ? { baseBranch: repo['baseBranch'] as string } : {}),
    },
    tasks,
    ...(plan ? { plan } : {}),
    ...(role ? { role } : {}),
    ...(assignee ? { assignee } : {}),
    ...(dependsOn ? { dependsOn } : {}),
    ...(raw['apiDocs'] ? { apiDocs: raw['apiDocs'] as string } : {}),
    ...(raw['codingStandard'] ? { codingStandard: raw['codingStandard'] as string } : {}),
    ...(raw['reportChannel'] ? { reportChannel: raw['reportChannel'] as string } : {}),
  };
}
