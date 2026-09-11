import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  // 生产对接 console-api（startConsoleServer），默认同源 /api
  server: {
    proxy: {
      '/api': 'http://localhost:3100',
    },
  },
  test: {
    environment: 'jsdom',
    // element-plus 被 vitest 外置化时，其依赖 async-validator（pika 构建、无 exports 字段）
    // 落到 node 原生解析的 CJS main，默认导出变成 namespace 对象——el-form 校验
    // `new AsyncValidator(...)` 直接崩（测试里校验形同虚设）。内联走 Vite 的 module 字段解析。
    server: { deps: { inline: ['element-plus'] } },
  },
});
