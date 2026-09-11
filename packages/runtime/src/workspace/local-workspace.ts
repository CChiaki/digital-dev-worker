import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { dirname, isAbsolute, resolve as pathResolve, sep } from 'node:path';
import type { Workspace } from './types.js';

/**
 * 本地文件系统工作区（Workspace 唯一实现）：root 内相对路径读写，路径逃逸一律拒绝。
 * - resolve 收口：绝对路径 / ../ 越界 / 深层穿越全部抛「越界」错——resolve 语义下
 *   绝对输入会替换 base，等价于任意文件访问，故与越界同级拒绝；
 * - root 惰性创建：构造不建目录（只读场景不落垃圾），首次写入自动建；
 * - editFile 唯一命中（P0 结论）：多处/零处命中报错且不改文件，防模型改错位置；
 * - listTree 跳过 .git / node_modules（快照/搜索不碰依赖与版本库元数据）。
 */
export class LocalWorkspace implements Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = pathResolve(root);
  }

  resolve(rel: string): string {
    if (isAbsolute(rel)) {
      throw new Error(`路径越界：不允许绝对路径（${rel}）`);
    }
    const abs = pathResolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`路径越界：${rel} 解析到 ${abs}，超出工作区 ${this.root}`);
    }
    return abs;
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const abs = this.resolve(rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }

  async readFile(rel: string): Promise<string> {
    const abs = this.resolve(rel);
    try {
      return await readFile(abs, 'utf8');
    } catch (e) {
      throw new Error(`读取失败（${rel}）：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async editFile(rel: string, oldText: string, newText: string): Promise<void> {
    const content = await this.readFile(rel);
    const hits = oldText ? content.split(oldText).length - 1 : 0;
    if (hits !== 1) {
      throw new Error(`替换失败（${rel}）：oldText 命中 ${hits} 处（须唯一），文件未修改`);
    }
    await writeFile(this.resolve(rel), content.replace(oldText, newText), 'utf8');
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await access(this.resolve(rel));
      return true;
    } catch {
      return false;
    }
  }

  async listTree(sub?: string, limit?: number): Promise<string[]> {
    const base = sub ? this.resolve(sub) : this.root;
    const out: string[] = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
      if (limit !== undefined && out.length >= limit) return;
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch {
        return; // root 未建/无权限：空树
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(`${abs}${sep}${e.name}`, child);
        else if (e.isFile()) out.push(child);
        if (limit !== undefined && out.length >= limit) return;
      }
    };
    await walk(base, '');
    return out;
  }
}
