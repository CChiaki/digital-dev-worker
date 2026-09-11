// packages/console-api/test/skill-injection.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSkillContext, materializeSkillAssets, PER_SKILL_LIMIT, TOTAL_SKILL_LIMIT, type SkillRecord } from '../src/team/skill-injection.js';

const skill = (over: Partial<SkillRecord>): SkillRecord => ({
  id: 'skill-a1', categoryId: 'backend', name: '异常码规范', description: '', type: 'knowledge',
  content: '异常码以 E 开头', status: 'approved', source: 'manual', createdAt: 1, ...over,
});

describe('appendSkillContext', () => {
  it('空清单原样返回', () => {
    const ins = '原始指令';
    expect(appendSkillContext(ins, [])).toBe(ins);
  });

  it('knowledge/constraint 追加「技能与约束」段', () => {
    const out = appendSkillContext('原始指令', [
      skill({}), skill({ id: 'skill-b2', name: '禁直连生产库', type: 'constraint', content: '禁止直连' }),
    ]);
    expect(out).toContain('原始指令');
    expect(out).toContain('## 技能与约束');
    expect(out).toContain('异常码规范');
    expect(out).toContain('禁止直连');
    expect(out).toContain('开发约束');
  });

  it('asset 只出资产清单不出正文', () => {
    const out = appendSkillContext('原始', [skill({
      id: 'skill-c3', name: '脚手架', type: 'asset', content: '使用说明',
      assetFiles: [{ path: 'scripts/init.sh', content: 'echo hi' }],
    })]);
    expect(out).toContain('.skills/skill-c3/scripts/init.sh');
    expect(out).toContain('受控 bash');
    expect(out).not.toContain('使用说明'); // asset 正文不注入
  });

  it('asset 多文件按 skill 分组：description 只注入一次并截断（2026-09-10 批量导入）', () => {
    const desc = '长'.repeat(500);
    const out = appendSkillContext('原始', [skill({
      id: 'skill-e6', name: '后端总览', type: 'asset', description: desc,
      assetFiles: [{ path: 'SKILL.md', content: 'a' }, { path: 'references/x.md', content: 'b' }, { path: 'references/y.md', content: 'c' }],
    })]);
    // description 截断到 ASSET_DESC_LIMIT 且全清单只出现一次
    expect(out.match(new RegExp(`长{300}…`, 'g'))?.length).toBe(1);
    expect(out).not.toContain('长'.repeat(301));
    // 三个文件逐行列出，挂在 skill 名下
    expect(out).toContain('- 后端总览：');
    expect(out).toContain('.skills/skill-e6/SKILL.md');
    expect(out).toContain('.skills/skill-e6/references/x.md');
    expect(out).toContain('.skills/skill-e6/references/y.md');
  });

  it('截断：单条 2000、总量 8000', () => {
    const long = appendSkillContext('原始', [skill({ content: 'x'.repeat(3000) })]);
    expect(long.length).toBeLessThan('原始'.length + 3000 + 200); // 单条被截
    expect(long).toContain('超长截断');
    const many = appendSkillContext('原始', Array.from({ length: 8 }, (_, i) => skill({ id: `skill-${i}`, content: 'y'.repeat(1500) })));
    const bodyLen = many.length - '原始'.length;
    expect(bodyLen).toBeLessThanOrEqual(TOTAL_SKILL_LIMIT + 2000); // 总量截断（末条可能整体注入后截）
    expect(many).toContain('## 技能与约束');
    expect(PER_SKILL_LIMIT).toBe(2000);
    expect(TOTAL_SKILL_LIMIT).toBe(8000);
  });
});

describe('materializeSkillAssets', () => {
  it('asset 文件落盘 workspace/.skills/<id>/，返回写入数；非 asset 忽略', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-'));
    const n = await materializeSkillAssets(dir, [
      skill({ id: 'skill-d4', type: 'asset', assetFiles: [{ path: 'scripts/a.sh', content: 'echo a' }, { path: 'nested/b.txt', content: 'b' }] }),
      skill({ id: 'skill-d5', type: 'asset', assetFiles: [{ path: 'run.sh', content: 'echo run' }] }),
      skill({}), // 非 asset
    ]);
    expect(n).toBe(3);
    expect(await readFile(join(dir, '.skills', 'skill-d4', 'scripts', 'a.sh'), 'utf8')).toBe('echo a');
    expect(await readFile(join(dir, '.skills', 'skill-d4', 'nested', 'b.txt'), 'utf8')).toBe('b');
    expect(await readFile(join(dir, '.skills', 'skill-d5', 'run.sh'), 'utf8')).toBe('echo run');
    await rm(dir, { recursive: true, force: true });
  });

  it('路径逃逸防护（终审 I1）：path 含 .. 抛错且不写盘', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-'));
    try {
      await expect(
        materializeSkillAssets(dir, [
          skill({ id: 'skill-evil', type: 'asset', assetFiles: [{ path: '../evil.sh', content: 'pwned' }] }),
        ]),
      ).rejects.toThrow('路径逃逸');
      // 越界文件不存在；.skills 下也无残留
      expect(existsSync(join(dir, 'evil.sh'))).toBe(false);
      expect(existsSync(join(dir, '.skills'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
