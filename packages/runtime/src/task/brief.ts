import type { TaskPackage, PlanItem } from './package.js';

/** 任务包 → 任务简报（systemPrompt）。
 *  结构化注入：任务标识/仓库分支/逐任务(files+要求+验收)/接口文档/编码规范/汇报渠道 + 工作约定。 */
export function buildTaskBrief(pkg: TaskPackage): string {
  const lines: string[] = [];

  lines.push(`# 任务简报：${pkg.title}（${pkg.taskId}）`);
  lines.push('');
  lines.push('## 代码仓库');
  lines.push(`- 仓库：${pkg.repo.url}`);
  lines.push(`- 工作分支：${pkg.repo.branch}`);
  if (pkg.repo.baseBranch) lines.push(`- 基线分支：${pkg.repo.baseBranch}`);
  lines.push('');

  lines.push('## 开发任务');
  for (const t of pkg.tasks) {
    lines.push(`### ${t.id} ${t.title}`);
    lines.push('- 涉及文件：');
    for (const f of t.files) lines.push(`  - ${f}`);
    lines.push(`- 开发要求：${t.requirement}`);
    lines.push('- 验收标准：');
    for (const a of t.acceptance) lines.push(`  - ${a}`);
  }
  lines.push('');

  if (pkg.apiDocs) {
    lines.push('## 接口文档');
    lines.push(pkg.apiDocs);
    lines.push('');
  }
  if (pkg.codingStandard) {
    lines.push('## 编码规范');
    lines.push(pkg.codingStandard);
    lines.push('');
  }
  if (pkg.reportChannel) {
    lines.push('## 汇报要求');
    lines.push(pkg.reportChannel);
    lines.push('');
  }

  lines.push('## 工作约定');
  lines.push('- 先熟悉任务涉及的现有代码，再动手开发；遵循仓库既有写法与规范。');
  lines.push('- 使用 gitlab_ 工具完成建分支、提交代码、创建 MR；使用 jira_ 工具同步任务状态。');
  lines.push('- 每个开发任务完成前，先按验收标准自测，全部通过才算完成。');
  lines.push('- 全部任务完成后，汇报：改动文件清单、各项验收标准的通过情况、遗留问题（如有）。');

  return lines.join('\n');
}

/** 计划项执行指令（计划执行器逐项下发）：序号/kind/要求/验证命令/前序摘要/申报指引 */
export function buildPlanItemInstruction(
  pkg: TaskPackage, item: PlanItem, index: number, total: number, doneSummary: string[],
): string {
  const lines: string[] = [];
  lines.push(`# 执行计划第 ${index + 1}/${total} 项：${item.title}`);
  lines.push(`- 任务包：${pkg.title}（${pkg.taskId}）`);
  lines.push(`- 仓库：${pkg.repo.url}　分支：${pkg.repo.branch}`);
  lines.push(`- 能力类型：${item.kind ?? 'dev'}`);
  lines.push(`- 本项要求：${item.detail}`);
  if (item.verify) lines.push(`- 完成后必须能通过验证命令：\`${item.verify}\`（系统会实际运行核对）`);
  if (doneSummary.length > 0) {
    lines.push('- 前序已完成项：');
    for (const s of doneSummary) lines.push(`  - ${s}`);
  }
  lines.push('');
  lines.push('完成本项后，调用 task_check 申报（item 参数填 "' + item.id + '"），并附验证输出摘要；未通过不要申报。');
  return lines.join('\n');
}
