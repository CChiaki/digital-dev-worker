import type { Tool, ToolResult } from '../types.js';
import type { LocalWorkspace } from './local-workspace.js';

/** list_files 单次返回上限（树过大的任务区截断，防上下文打爆） */
const LIST_LIMIT = 500;
/** grep_files 匹配行数上限（同上） */
const GREP_LIMIT = 200;
/** grep_files 单行长度上限（2026-09-11 事故修复）：minified/打包产物单行可达数 MB，
 *  行数上限防不住——一次 grep 命中 content2.js 就把 26 万 token 上下文撑到 72 万，
 *  此后任务所有模型调用 400 全军覆没。工具结果必须可预算，单行截断留痕原文长度 */
const GREP_LINE_CHARS = 500;
/** grep_files 累计返回字符上限（单行上限的二次兜底：行多且都接近上限同样打爆） */
const GREP_TOTAL_CHARS = 50_000;
/** read_file 全文字符上限（超长文件/打包产物整读同样打爆上下文，截断尾部并留痕） */
const READ_FILE_CHARS = 100_000;

/** 必填 string 参数取出（缺/空/类型不对 → undefined，统一转 ok:false） */
const str = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

/** 工作区异常 → 工具失败结果（不向模型抛裸异常，错误信息即纠错提示） */
const fail = (e: unknown): ToolResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

/**
 * 工作区编码工具集（write/read/edit/list/grep 五件套）：模型侧只见相对路径，
 * 越界/多命中/缺参等全部以 ok:false + 中文原因返回，可自行纠错重试。
 */
export function createWorkspaceTools(ws: LocalWorkspace): Tool[] {
  const write_file: Tool = {
    name: 'write_file',
    description: '写文件（相对工作区路径，自动建父目录，覆盖整文件）',
    parameters: {
      path: { type: 'string', description: '相对路径，如 src/index.ts', required: true },
      content: { type: 'string', description: '完整文件内容', required: true },
    },
    async execute(args) {
      try {
        const path = str(args, 'path');
        const content = typeof args.content === 'string' ? args.content : undefined;
        if (!path || content === undefined) return { ok: false, error: '缺少参数 path / content' };
        await ws.writeFile(path, content);
        return { ok: true, data: { path } };
      } catch (e) {
        return fail(e);
      }
    },
  };

  const read_file: Tool = {
    name: 'read_file',
    description: '读文件全文（相对工作区路径）',
    parameters: {
      path: { type: 'string', description: '相对路径', required: true },
    },
    async execute(args) {
      try {
        const path = str(args, 'path');
        if (!path) return { ok: false, error: '缺少参数 path' };
        const content = await ws.readFile(path);
        // 全文长度上限（2026-09-11 事故修复）：打包产物/超大文件整读打爆上下文——
        // 截断尾部并明示，引导模型改用 grep_files 定位后读局部
        if (content.length > READ_FILE_CHARS) {
          return {
            ok: true,
            data: {
              truncated: true,
              content: `${content.slice(0, READ_FILE_CHARS)}\n…（超长截断，全文 ${content.length} 字符——建议 grep_files 定位目标后改读局部或用 edit_file 直接替换）`,
            },
          };
        }
        return { ok: true, data: { content } };
      } catch (e) {
        return fail(e);
      }
    },
  };

  const edit_file: Tool = {
    name: 'edit_file',
    description: '精确替换：oldText 在文件中必须唯一命中，多处/零处命中不改文件并报错',
    parameters: {
      path: { type: 'string', description: '相对路径', required: true },
      oldText: { type: 'string', description: '被替换的原文（须唯一）', required: true },
      newText: { type: 'string', description: '替换为的新文本', required: true },
    },
    async execute(args) {
      try {
        const path = str(args, 'path');
        const oldText = str(args, 'oldText');
        const newText = typeof args.newText === 'string' ? args.newText : undefined;
        if (!path || !oldText || newText === undefined) {
          return { ok: false, error: '缺少参数 path / oldText / newText' };
        }
        await ws.editFile(path, oldText, newText);
        return { ok: true, data: { path } };
      } catch (e) {
        return fail(e);
      }
    },
  };

  const list_files: Tool = {
    name: 'list_files',
    description: '递归列出工作区文件树（跳过 .git / node_modules，超限截断）',
    parameters: {
      path: { type: 'string', description: '子目录相对路径（缺省整棵树）' },
    },
    async execute(args) {
      try {
        const sub = str(args, 'path');
        const files = await ws.listTree(sub, LIST_LIMIT + 1);
        return { ok: true, data: { files: files.slice(0, LIST_LIMIT), truncated: files.length > LIST_LIMIT } };
      } catch (e) {
        return fail(e);
      }
    },
  };

  const grep_files: Tool = {
    name: 'grep_files',
    description: '按子串搜工作区文件内容，返回 path:行号:内容 匹配行',
    parameters: {
      pattern: { type: 'string', description: '搜索子串', required: true },
      path: { type: 'string', description: '限定子目录（缺省整棵树）' },
    },
    async execute(args) {
      try {
        const pattern = str(args, 'pattern');
        if (!pattern) return { ok: false, error: '缺少参数 pattern' };
        const sub = str(args, 'path');
        const files = await ws.listTree(sub);
        const matches: string[] = [];
        let total = 0;       // 累计返回字符（GREP_TOTAL_CHARS 兜底）
        let truncated = false;
        outer: for (const f of files) {
          if (matches.length >= GREP_LIMIT) break;
          const content = await ws.readFile(f).catch(() => undefined);
          if (content === undefined) continue;
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= GREP_LIMIT) break outer;
            const raw = lines[i]!;
            if (!raw.includes(pattern)) continue;
            // 单行截断（2026-09-11 事故修复）：minified 产物单行数 MB，不设行上限一次命中即打爆上下文
            const line = raw.length > GREP_LINE_CHARS
              ? `${raw.slice(0, GREP_LINE_CHARS)}…（行截断，原文 ${raw.length} 字符）`
              : raw;
            matches.push(`${f}:${i + 1}:${line}`);
            total += line.length;
            if (total >= GREP_TOTAL_CHARS) { truncated = true; break outer; }
          }
        }
        if (matches.length === 0) return { ok: false, error: `无命中（pattern: ${pattern}）` };
        return {
          ok: true,
          data: {
            matches,
            ...(truncated ? { truncated: true, note: '结果因长度上限提前截断——请缩小 pattern 或限定 path 子目录' } : {}),
          },
        };
      } catch (e) {
        return fail(e);
      }
    },
  };

  return [write_file, read_file, edit_file, list_files, grep_files];
}
