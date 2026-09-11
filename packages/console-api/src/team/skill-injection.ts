// packages/console-api/src/team/skill-injection.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { SkillRecord } from './skill-store.js';

/** 单条 skill 正文注入上限（防 token 爆炸，spec §四） */
export const PER_SKILL_LIMIT = 2000;
/** 全部 skill 注入总上限 */
export const TOTAL_SKILL_LIMIT = 8000;
/** asset 清单里 description 注入上限（2026-09-10 /opt/skills 批量导入）：导入 skill 描述可达数百字符，
 *  旧格式逐 assetFile 重复注入 description，多文件 skill 会数倍挤占指令预算——改按 skill 分组只注入一次并截断 */
export const ASSET_DESC_LIMIT = 300;

export type { SkillRecord } from './skill-store.js';

/**
 * 指令追加段（spec §四）：knowledge/constraint 正文拼入「技能与约束」段；
 * asset 只列「可用资产清单」（路径 + 用途），正文不注入——员工用受控 bash 自行调用。
 * 空清单原样返回（零注入零开销）。
 */
export function appendSkillContext(instruction: string, skills: SkillRecord[]): string {
  const docs = skills.filter((s) => s.type !== 'asset');
  const assets = skills.filter((s) => s.type === 'asset');
  if (docs.length === 0 && assets.length === 0) return instruction;

  const lines: string[] = ['', '## 技能与约束（来自 Skill 库，必须遵守）'];
  let used = 0;
  for (const s of docs) {
    if (used >= TOTAL_SKILL_LIMIT) {
      lines.push('…（后续技能因总量限制未注入）');
      break;
    }
    let body = s.content;
    if (body.length > PER_SKILL_LIMIT) body = `${body.slice(0, PER_SKILL_LIMIT)}…（超长截断）`;
    if (used + body.length > TOTAL_SKILL_LIMIT) {
      body = `${body.slice(0, Math.max(0, TOTAL_SKILL_LIMIT - used))}…（总量截断）`;
    }
    used += body.length;
    lines.push(`### ${s.name}（${s.type === 'constraint' ? '开发约束' : '知识'}）`);
    lines.push(body);
  }
  if (assets.length > 0) {
    lines.push('### 可用技能资产');
    lines.push('以下资产已放置在工作区 .skills/ 目录，可用受控 bash 调用（建议先读该目录下 SKILL.md 了解用法）：');
    // 按 skill 分组（2026-09-10 批量导入 /opt/skills）：description 只注入一次并截断，
    // 文件逐行列在组内——旧格式逐文件重复 description，一个 10 文件 skill 即膨胀数千字符
    for (const s of assets) {
      let desc = s.description ?? '';
      if (desc.length > ASSET_DESC_LIMIT) desc = `${desc.slice(0, ASSET_DESC_LIMIT)}…`;
      lines.push(`- ${s.name}${desc ? `：${desc}` : ''}（.skills/${s.id}/）`);
      for (const f of s.assetFiles ?? []) lines.push(`  - .skills/${s.id}/${f.path}`);
    }
  }
  return `${instruction}\n${lines.join('\n')}`;
}

/** asset 落盘（spec §四）：workspace/.skills/<skillId>/<path> 逐文件写入；返回写入文件数 */
export async function materializeSkillAssets(workspaceDir: string, skills: SkillRecord[]): Promise<number> {
  let count = 0;
  for (const s of skills.filter((x) => x.type === 'asset')) {
    // 运行时防护（终审 I1）：assetFiles.path 语义为相对 .skills/<skillId>/，
    // resolved 路径必须落在该 skill 自己的目录内（.. 跳出即拒），防库内脏数据路径逃逸写盘
    const root = resolve(join(workspaceDir, '.skills', s.id));
    for (const f of s.assetFiles ?? []) {
      const target = join(workspaceDir, '.skills', s.id, f.path);
      const resolved = resolve(target);
      if (!resolved.startsWith(root + sep)) throw new Error(`assetFiles.path 路径逃逸: ${f.path}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.content, 'utf8');
      count++;
    }
  }
  return count;
}
