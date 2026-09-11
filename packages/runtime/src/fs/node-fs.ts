import * as os from 'node:os';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ok, err, FileError } from '@earendil-works/pi-agent-core';
import type { FileSystem, FileInfo } from '@earendil-works/pi-agent-core';

/**
 * pi 的 FileSystem 接口的 Node.js 最小适配器。
 * pi-agent-core 未内置 Node 适配器，此文件即 P1 产品层的起点（spike 先验证可行性）。
 * 只实现 FileSystem 全集中确实被用到的部分；用不到的方法抛 not_supported。
 */
function wrap<T>(p: Promise<T>, pathStr: string): Promise<import('@earendil-works/pi-agent-core').Result<T, FileError>> {
  return p.then(
    (v) => ok(v),
    (e) =>
      err(
        new FileError(
          (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unknown',
          String((e as Error).message ?? e),
          pathStr,
          e instanceof Error ? e : undefined,
        ),
      ),
  );
}

export function makeNodeFs(cwd: string): FileSystem {
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(cwd, p));
  return {
    cwd,
    absolutePath: (p) => Promise.resolve(ok(abs(p))),
    joinPath: (parts) => Promise.resolve(ok(path.join(...parts))),
    canonicalPath: (p) => wrap(fsp.realpath(abs(p)), p),
    readTextFile: (p) => wrap(fsp.readFile(abs(p), 'utf8'), p),
    readTextLines: (p, options) =>
      wrap(
        fsp
          .readFile(abs(p), 'utf8')
          .then((t) => {
            const lines = t.split('\n');
            return options?.maxLines ? lines.slice(0, options.maxLines) : lines;
          }),
        p,
      ),
    readBinaryFile: (p) => wrap(fsp.readFile(abs(p)), p),
    writeFile: (p, content) => wrap(fsp.mkdir(path.dirname(abs(p)), { recursive: true }).then(() => fsp.writeFile(abs(p), content)), p),
    appendFile: (p, content) => wrap(fsp.mkdir(path.dirname(abs(p)), { recursive: true }).then(() => fsp.appendFile(abs(p), content)), p),
    renameFile: (s, d) => wrap(fsp.rename(abs(s), abs(d)), s),
    fileInfo: async (p) => {
      const r = await wrap(fsp.stat(abs(p)), p);
      if (!r.ok) return r;
      const st = r.value;
      const info: FileInfo = {
        name: path.basename(abs(p)),
        path: abs(p),
        kind: st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'file',
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
      return ok(info);
    },
    listDir: async (p) => {
      const r = await wrap(fsp.readdir(abs(p), { withFileTypes: true }), p);
      if (!r.ok) return r;
      const infos = await Promise.all(
        r.value.map(async (d) => {
          const full = path.join(abs(p), d.name);
          const st = await fsp.stat(full);
          const info: FileInfo = {
            name: d.name,
            path: full,
            kind: d.isDirectory() ? 'directory' : d.isSymbolicLink() ? 'symlink' : 'file',
            size: st.size,
            mtimeMs: st.mtimeMs,
          };
          return info;
        }),
      );
      return ok(infos);
    },
    exists: async (p) => {
      try {
        await fsp.access(abs(p));
        return ok(true);
      } catch {
        return ok(false);
      }
    },
    createDir: (p) => wrap(fsp.mkdir(abs(p), { recursive: true }).then(() => undefined), p),
    remove: (p, options) =>
      wrap(fsp.rm(abs(p), { recursive: options?.recursive ?? false, force: options?.force ?? false }), p),
    createTempDir: (prefix) =>
      wrap(fsp.mkdtemp(path.join(os.tmpdir(), prefix ?? 'tmp-')), ''),
    createTempFile: () => Promise.resolve(err(new FileError('not_supported', 'createTempFile not implemented'))),
    /** FileSystem 接口要求：尽力释放资源，不得抛错（Node 适配器无持久资源） */
    cleanup: () => Promise.resolve(),
  };
}
