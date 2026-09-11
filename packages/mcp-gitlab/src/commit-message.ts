/**
 * 提交信息规范（2026-09-09 用户需求，2026-09-10 增补分支名）：数字员工的代码提交必须
 * 「类型(分支)前缀 + 列出修改文件 + 修改内容点」。GitLab/Gitea 两套 commit 工具共用：
 * - 首行格式：`<类型>(<分支>): <一句话摘要>`（如 feat(main): / fix(master):）——类型受限集、
 *   分支为提交目标分支名（与 commit 工具的 branch 参数一致，不一致即拒绝）；
 * - 内容点：模型必须在 message 里写「内容点:」段落（逐文件一行修改说明）——缺失/为空
 *   → 拒绝执行，错误信息内嵌格式模板，模型可自查重试；
 * - 修改文件：工具按实际提交的 files 自动补全「修改文件:」清单（模型手写易与实际
 *   提交内容不符，故由机器生成；message 已含该段落则原样保留）。
 * 半角/全角冒号均识别。
 */

/** 允许的提交类型（conventional commits 常用集） */
export const COMMIT_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'] as const;

/** message 规范模板（拒绝时的自查提示） */
export const COMMIT_MESSAGE_TEMPLATE = `message 须为以下格式（首行「类型(分支): 摘要」+ 内容点段落，逐文件说明修改内容）：
<类型>(<分支>): <一句话摘要>

内容点:
- <文件路径>: <该文件改了什么>
示例：
feat(main): 登录模块重构

内容点:
- src/views/login/index.vue: 表单校验改为异步，增加 loading 态
- src/api/auth.ts: 新增登出接口`;

/** message 中「内容点:」段落的正文（去掉段名后的剩余内容，全空白 = 未写） */
function contentPoints(message: string): string {
  const idx = message.search(/内容点\s*[:：]/);
  if (idx < 0) return '';
  return message.slice(idx).replace(/内容点\s*[:：]/, '').trim();
}

/** 首行 `类型(分支): 摘要` 解析（缺格式/类型不在清单/摘要为空 → 错误说明） */
function parseFirstLine(
  message: string,
): { ok: true; type: string; branch: string } | { ok: false; error: string } {
  const first = message.split('\n', 1)[0].trim();
  const m = /^([a-z]+)\(([A-Za-z0-9._/-]+)\)\s*[:：]\s*(.*)$/.exec(first);
  if (!m) {
    return {
      ok: false,
      error: `提交说明首行必须是「类型(分支): 摘要」格式（如 feat(main): xxx / fix(master): xxx，分支名与提交目标分支一致）。${COMMIT_MESSAGE_TEMPLATE}`,
    };
  }
  const [, type, branch, summary] = m;
  if (!(COMMIT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `提交类型「${type}」不在允许清单（${COMMIT_TYPES.join('/')}）。${COMMIT_MESSAGE_TEMPLATE}` };
  }
  if (!summary.trim()) {
    return { ok: false, error: `提交说明首行「${type}(${branch}):」后缺少摘要。${COMMIT_MESSAGE_TEMPLATE}` };
  }
  return { ok: true, type, branch };
}

/**
 * 校验并补全提交信息：
 * - 首行须为 `类型(分支): 摘要`；传入 branch（commit 工具的目标分支）时括号内分支须与其一致；
 * - ok:false = 首行格式/类型/分支不一致，或缺「内容点:」段落或段落为空（错误带格式模板）；
 * - ok:true  = 可直接使用的最终 message（原文 + 自动补全的「修改文件:」清单）。
 */
export function enforceCommitMessage(
  message: string,
  files: { path: string }[],
  branch?: string,
): { ok: true; message: string } | { ok: false; error: string } {
  const first = parseFirstLine(message);
  if (!first.ok) return first;
  if (branch !== undefined && first.branch !== branch) {
    return {
      ok: false,
      error: `首行括号内分支「${first.branch}」与本次提交目标分支「${branch}」不一致，请改为 ${first.type}(${branch}):。${COMMIT_MESSAGE_TEMPLATE}`,
    };
  }
  if (!message.search(/内容点\s*[:：]/)) {
    return { ok: false, error: `提交说明缺少「内容点:」段落（须逐文件列出修改内容点）。${COMMIT_MESSAGE_TEMPLATE}` };
  }
  if (!contentPoints(message)) {
    return { ok: false, error: `提交说明的「内容点:」段落为空（须逐文件列出修改内容点）。${COMMIT_MESSAGE_TEMPLATE}` };
  }
  if (/修改文件\s*[:：]/.test(message)) return { ok: true, message };
  const list = files.map((f) => `- ${f.path}`).join('\n');
  return { ok: true, message: `${message.trimEnd()}\n\n修改文件:\n${list}` };
}
