import { defineConfig, type Plugin } from 'vitest/config';

/**
 * node:sqlite 为 Node 26 内置驱动（零依赖），vite 5 内置模块清单未收录（会被规范化为
 * "sqlite" 后当作普通包解析而失败）。用 virtual shim 经 createRequire 原生加载绕过，
 * 待升级 vite≥6 后可移除。
 */
const nodeSqliteShim: Plugin = {
  name: 'node-sqlite-shim',
  enforce: 'pre',
  resolveId(id) {
    if (id === 'node:sqlite') return '\0node:sqlite';
  },
  load(id) {
    if (id === '\0node:sqlite') {
      return [
        "import { createRequire } from 'node:module';",
        "const require = createRequire(import.meta.url);",
        "const sqlite = require('node:sqlite');",
        'export const DatabaseSync = sqlite.DatabaseSync;',
      ].join('\n');
    }
  },
};

export default defineConfig({
  plugins: [nodeSqliteShim],
});
