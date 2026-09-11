# 贡献指南

感谢关注「数字开发分身」！欢迎通过 Issue 反馈问题、通过 Pull Request 贡献代码。

## 环境要求

- Node ≥ 20.5（用到 `node:sqlite` 等新 API）
- pnpm ≥ 9
- 全程可离线开发：测试不依赖模型集群与公网（e2e 用 `test/fixtures/faux-agent*.mjs` 预设回复代理）

## 快速上手

```bash
pnpm install
pnpm -r test        # 全仓测试（应全绿）
pnpm -r typecheck   # 全仓类型检查（应全绿）
```

本地起服见 [README「快速开始」](README.md)；开发常用命令、包职责、配置全链路说明见 [docs/开发指南.md](docs/开发指南.md)。

## 开发约定

- **产品语言全中文**：代码注释、测试名、提交信息均为中文；注释密度高、常带「为什么」，新接口/字段补注释时说明需求背景与日期
- **TypeScript NodeNext**：相对导入写 `.js` 后缀（实际指向 `.ts`）
- **配置项全链路贯通**：新增 yaml 配置项必须从 `runtime-config.ts` 一路传到 `@ddw/runtime`，检查清单见开发指南「执行链路」一节
- **存储层接口先行**：业务侧只依赖 `TaskStore`/`EventStore` 等接口，方言差异收在 `stores/sql/driver.ts`；新增记录的次序键用 `sortableId()`，不要用 randomUUID
- **测试**：新功能配套测试；等待外部状态用轮询 + 超时模式，不要固定 `sleep` 断言（并发跑时 fs 落盘有竞态）

## 提交规范（强制）

由 `packages/mcp-gitlab/src/commit-message.ts` 强制校验，人工提交同样遵守：

- 首行：`<类型>(<分支>): <一句话摘要>`，类型限 feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert
- 正文必须含 `内容点:` 段落，逐文件一行说明改了什么

```
feat(master): webhook 通知渠道接入

内容点:
- src/team/notifier.ts: webhook 渠道报文组装与业务状态校验
- runtime yaml: 通知渠道段配置
```

## Pull Request 流程

1. 从 `master` 拉出功能分支开发
2. 提交前确保 `pnpm -r test` 与 `pnpm -r typecheck` 全绿
3. PR 描述说明：改了什么、为什么、如何验证；涉及配置项/接口变更时同步更新文档（README / docs / examples）
4. 等待 review，通过后 squash 合入

## 安全须知

- 任何真实凭据（token / apiKey / 密码）不得入库；配置一律走 `enc:v1:` 密文或 `.gitignore` 排除的本地文件
- 发现安全问题请勿公开提 Issue，联系仓库维护者私下处理
