// fork worker 的 execArgv --import 入口：让裸 node 直跑本仓库 TS 源码。
// 背景：源码为 NodeNext 风格 `.js` 后缀相对导入 + 大量参数属性（constructor(private readonly ...)）
// 等非可擦除语法——原生类型剥离既不重写后缀也不支持参数属性，故需要：
//   resolve：`.js` 导入解析到同名 `.ts`
//   load  ：typescript.transpileModule 现场转译（零产物，等同 jit 编译）
// vitest/vite 不经过此路径（有自己的解析与转换管线）。
import { registerHooks } from 'node:module';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript'); // console-api devDependencies 自带

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js')) {
        try {
          return next(specifier.slice(0, -3) + '.ts', context);
        } catch {
          // 原错误更真实（可能确实缺文件）——透传
        }
      }
      throw err;
    }
  },

  load(url, context, next) {
    if (url.endsWith('.ts')) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
      });
      return { format: 'module', shortCircuit: true, source: outputText };
    }
    return next(url, context);
  },
});
