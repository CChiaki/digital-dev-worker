import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalWorkspace } from '../src/workspace/local-workspace.js';
import { createWorkspaceTools } from '../src/workspace/tools.js';
import type { Tool } from '../src/types.js';

let dir: string;
let tools: Map<string, Tool>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ddw-wstools-'));
  tools = new Map(createWorkspaceTools(new LocalWorkspace(dir)).map((t) => [t.name, t]));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('write_file / read_file', () => {
  it('写后可读；写失败路径越界 ok:false', async () => {
    const w = await tools.get('write_file')!.execute({ path: 'src/a.ts', content: 'const a = 1;' });
    expect(w.ok).toBe(true);

    const r = await tools.get('read_file')!.execute({ path: 'src/a.ts' });
    expect(r).toEqual({ ok: true, data: { content: 'const a = 1;' } });

    const bad = await tools.get('write_file')!.execute({ path: '../evil.txt', content: 'x' });
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toContain('越界');
  });

  it('read 不存在 → ok:false', async () => {
    const r = await tools.get('read_file')!.execute({ path: 'nope.txt' });
    expect(r.ok).toBe(false);
  });
});

describe('edit_file', () => {
  it('唯一命中替换 ok:true', async () => {
    await tools.get('write_file')!.execute({ path: 'app.js', content: 'a = 1;\nb = 2;' });
    const r = await tools.get('edit_file')!.execute({ path: 'app.js', oldText: 'a = 1;', newText: 'a = 42;' });
    expect(r.ok).toBe(true);
    const read = await tools.get('read_file')!.execute({ path: 'app.js' });
    expect((read as { data: { content: string } }).data.content).toBe('a = 42;\nb = 2;');
  });

  it('多处/无命中 → ok:false 带命中数', async () => {
    await tools.get('write_file')!.execute({ path: 'app.js', content: 'x;\nx;' });
    const many = await tools.get('edit_file')!.execute({ path: 'app.js', oldText: 'x;', newText: 'y;' });
    expect(many.ok).toBe(false);
    expect((many as { error: string }).error).toContain('2 处');

    const none = await tools.get('edit_file')!.execute({ path: 'app.js', oldText: 'zzz', newText: 'y' });
    expect(none.ok).toBe(false);
  });
});

describe('list_files / grep_files', () => {
  it('list_files 列出文件树', async () => {
    await tools.get('write_file')!.execute({ path: 'src/a.ts', content: '1' });
    await tools.get('write_file')!.execute({ path: 'test/b.ts', content: '2' });
    const r = await tools.get('list_files')!.execute({});
    expect(r).toEqual({ ok: true, data: { files: ['src/a.ts', 'test/b.ts'], truncated: false } });
  });

  it('grep_files 内容搜索（path:line:内容）', async () => {
    await tools.get('write_file')!.execute({ path: 'src/a.ts', content: 'const a = 1;\nconst b = LOGIN_URL;\n' });
    await tools.get('write_file')!.execute({ path: 'src/c.ts', content: 'LOGIN_URL = "x";\n' });
    const r = await tools.get('grep_files')!.execute({ pattern: 'LOGIN_URL' });
    expect(r.ok).toBe(true);
    expect((r as { data: { matches: string[] } }).data.matches).toEqual([
      'src/a.ts:2:const b = LOGIN_URL;',
      'src/c.ts:1:LOGIN_URL = "x";',
    ]);
  });

  it('grep 无命中 → ok:false 提示', async () => {
    const r = await tools.get('grep_files')!.execute({ pattern: '不存在的内容' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('无命中');
  });

  // 2026-09-11 事故修复：minified/打包产物单行可达数 MB，行数上限防不住——
  // 一次 grep 命中 content2.js 就把 26 万 token 上下文撑到 72 万，任务后续模型调用全 400
  it('grep 单行超长截断：命中行只返回前段并留痕原文长度', async () => {
    const huge = 'x'.repeat(3000) + 'TARGET' + 'y'.repeat(3000);
    await tools.get('write_file')!.execute({ path: 'dist/bundle.js', content: huge });
    const r = await tools.get('grep_files')!.execute({ pattern: 'TARGET' });
    expect(r.ok).toBe(true);
    const { matches } = (r as { data: { matches: string[] } }).data;
    expect(matches).toHaveLength(1);
    expect(matches[0]!.length).toBeLessThan(700); // 500 上限 + 路径行号 + 截断标注
    expect(matches[0]!).toContain('行截断，原文 6006 字符');
  });

  it('grep 累计字符超限提前收口：truncated 标记 + 引导缩小范围', async () => {
    // 每行 600 字符 × 120 行 × 2 文件 ≈ 144KB，远超 50KB 累计上限
    const line = `${'a'.repeat(595)}TGT\n`;
    await tools.get('write_file')!.execute({ path: 'big/one.log', content: line.repeat(120) });
    await tools.get('write_file')!.execute({ path: 'big/two.log', content: line.repeat(120) });
    const r = await tools.get('grep_files')!.execute({ pattern: 'TGT' });
    expect(r.ok).toBe(true);
    const data = (r as { data: { matches: string[]; truncated?: boolean; note?: string } }).data;
    expect(data.truncated).toBe(true);
    expect(data.note).toContain('缩小 pattern');
    // 行数上限是 200，提前收口说明累计字符上限先触发
    expect(data.matches.length).toBeLessThan(200);
  });

  it('read_file 超长全文截断尾部并留痕（防打包产物打爆上下文）', async () => {
    await tools.get('write_file')!.execute({ path: 'dist/huge.js', content: 'H'.repeat(150_000) + 'TAIL' });
    const r = await tools.get('read_file')!.execute({ path: 'dist/huge.js' });
    expect(r.ok).toBe(true);
    const data = (r as { data: { content: string; truncated?: boolean } }).data;
    expect(data.truncated).toBe(true);
    expect(data.content.length).toBeLessThan(110_000); // 100K 上限 + 截断标注
    expect(data.content).toContain('超长截断，全文 150004 字符');
    expect(data.content).not.toContain('TAIL'); // 尾部确实没进上下文
  });
});

describe('参数校验', () => {
  it('缺参数 → ok:false', async () => {
    expect((await tools.get('read_file')!.execute({})).ok).toBe(false);
    expect((await tools.get('write_file')!.execute({ path: 'x' })).ok).toBe(false);
    expect((await tools.get('edit_file')!.execute({ path: 'x', oldText: 'a' })).ok).toBe(false);
  });
});
