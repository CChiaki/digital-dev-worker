import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalWorkspace } from '../src/workspace/local-workspace.js';

let dir: string;
let ws: LocalWorkspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ddw-ws-'));
  ws = new LocalWorkspace(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('LocalWorkspace 基础读写', () => {
  it('writeFile 自动建目录；readFile 读回', async () => {
    await ws.writeFile('src/views/index.vue', '<template>ok</template>');
    expect(await ws.readFile('src/views/index.vue')).toBe('<template>ok</template>');
    // 真实落盘
    expect(await readFile(join(dir, 'src/views/index.vue'), 'utf8')).toBe('<template>ok</template>');
  });

  it('readFile 不存在 → 抛可读错误', async () => {
    await expect(ws.readFile('nope.txt')).rejects.toThrow('nope.txt');
  });

  it('exists', async () => {
    await ws.writeFile('a.txt', 'x');
    expect(await ws.exists('a.txt')).toBe(true);
    expect(await ws.exists('b.txt')).toBe(false);
  });
});

describe('editFile 精确替换（P0 结论：oldText 唯一命中）', () => {
  it('唯一命中 → 替换并落盘', async () => {
    await ws.writeFile('app.js', 'const a = 1;\nconst b = 2;\n');
    await ws.editFile('app.js', 'const a = 1;', 'const a = 100;');
    expect(await ws.readFile('app.js')).toBe('const a = 100;\nconst b = 2;\n');
  });

  it('多处命中 → 报错并指出命中次数，文件不变', async () => {
    await ws.writeFile('app.js', 'x = 1;\nx = 1;\n');
    await expect(ws.editFile('app.js', 'x = 1;', 'x = 2;')).rejects.toThrow('2 处');
    expect(await ws.readFile('app.js')).toBe('x = 1;\nx = 1;\n');
  });

  it('无命中 → 报错', async () => {
    await ws.writeFile('app.js', 'y = 1;\n');
    await expect(ws.editFile('app.js', 'not exist', 'z')).rejects.toThrow('0 处');
  });
});

describe('listTree', () => {
  it('递归列出相对路径，跳过 .git 与 node_modules', async () => {
    await ws.writeFile('src/a.ts', 'a');
    await ws.writeFile('test/b.ts', 'b');
    await ws.writeFile('.git/HEAD', 'ref: x');
    await ws.writeFile('node_modules/v/p.json', '{}');
    const files = await ws.listTree();
    expect(files).toEqual(['src/a.ts', 'test/b.ts']);
  });

  it('limit 截断', async () => {
    for (let i = 0; i < 5; i++) await ws.writeFile(`f${i}.txt`, 'x');
    expect((await ws.listTree(undefined, 3)).length).toBe(3);
  });
});

describe('路径逃逸防护', () => {
  it('../ 越界拒绝', () => {
    expect(() => ws.resolve('../outside.txt')).toThrow('越界');
  });

  it('绝对路径一律拒绝（resolve 语义：绝对输入替换 base）', () => {
    expect(() => ws.resolve('/etc/passwd')).toThrow('越界');
  });

  it('深层穿越拒绝', () => {
    expect(() => ws.resolve('src/../../etc/passwd')).toThrow('越界');
  });

  it('越界读写均被拒', async () => {
    await expect(ws.readFile('../x')).rejects.toThrow('越界');
    await expect(ws.writeFile('../x', 'y')).rejects.toThrow('越界');
  });
});

describe('root 自动创建', () => {
  it('root 不存在时构造惰性、首次写入自动创建', async () => {
    const nested = join(dir, 'not-yet', 'workspace');
    const ws2 = new LocalWorkspace(nested);
    await ws2.writeFile('hello.txt', 'hi');
    expect(await readFile(join(nested, 'hello.txt'), 'utf8')).toBe('hi');
  });
});
