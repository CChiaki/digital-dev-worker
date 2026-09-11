# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库概述

强合规内网离线部署的「数字员工」研发一体化平台（pnpm monorepo）。数字员工以任务包（yaml 工单）为输入，端到端完成开发/测试/提交/发布。产品语言全中文：代码注释、测试名、提交信息均为中文，新代码保持同样风格（注释常带日期标注，如 `（2026-09-10 用户需求）`）。

## 常用命令

```bash
pnpm install
pnpm -r test            # 全仓测试
pnpm -r typecheck       # 全仓类型检查

# 单包测试（console-api 为例）
cd packages/console-api
npx vitest run                              # 该包全量
npx vitest run test/notifier.test.ts        # 单文件
npx vitest run test/notifier.test.ts -t 'webhook'  # 单用例（按名称过滤）

# 后端本地起服（直接跑 TS 源码，无构建步骤，端口 3100）
pnpm dev:api            # = node --import packages/console-api/src/team/ts-register.mjs packages/console-api/src/cli.ts --runtime runtime-local.yaml

# 前端
pnpm dev:web            # vite dev
pnpm --filter console exec npx vite build   # 打包
```

## 关键架构

### 执行链路（改配置项时必须全链路检查）

新 yaml 配置项需要贯通的完整链路（漏一段就静默失效，默认值兜底）：

```
runtime-local.yaml
  → runtime-config.ts parseRuntimeConfig（校验 + 透传，ConsoleRuntimeConfig 加字段）
  → http/server.ts startConsoleServer（opts.runtime 整体 spread 进 pipeline）
  → pipeline.ts createRuntimePipeline（ConsoleRuntimeOptions 加字段）
  → 两条执行分支都要传：
      inproc: executor.ts createEmployeeExecutor（plan 分支 runTaskPlan + 纯任务分支 assembleDefaultRuntime）
      fork:   process-executor.ts → worker.ts runJob（config 快照随 job 下发）
  → plan-runner.ts PlanRunInput → assembleDefaultRuntime
  → @ddw/runtime EmployeeRuntime（config.maxTurns ?? 默认值）
```

示例：`maxTurns`、`bashTimeoutMs` 都走这条链。

### 包职责

- **packages/runtime（@ddw/runtime）**：执行内核。EmployeeRuntime（对话循环、maxTurns=40 缺省）、双协议模型网关（openai-completions / anthropic-messages）、受控 bash（白名单/黑名单/禁组合命令）、session 落盘、事件总线 + 审计 hash 链、workspace。
- **packages/console-api**：控制台 API + 调度。`src/team/`（pipeline 装配、scheduler 调度、executor/worker 执行、plan-runner 计划逐项、notifier 通知渠道、bash-approval 白名单外人工放行、review-gate 盯梢闸门、credentials enc:v1 密文）；`src/stores/sql/`（sqlite/mysql 双驱动，全部业务表 `ddw_*`，Driver 抽象抹平方言差异）；`src/http/`（server 装配 + handlers 路由）。
- **packages/mcp-gitlab / mcp-jira / mcp-ci / mcp-deploy / mcp-testenv / mcp-browser**：远端工具 MCP 包，Transport 接口 + 生产 HTTP 实现 + 测试 Fake。
- **apps/console**：管理台前端（Vue3 + Element Plus + Tailwind v4），页面即 views/*.vue（任务中心/数字员工/人工放行/审计台账/Skill 库/能力管理/通知渠道）。

### 任务生命周期与重跑

draft → pending → claimed → running → done/failed。`SqlTaskStore.add()` 是 **upsert**：同 taskId 重提交会清空执行态（claimedBy/result/planProgress/failedItemId）回到 pending——这是「任务回归初始状态重跑」的实现方式；`resumePlan`（POST /api/tasks/:id/resume）是 failed 计划的断点续跑（保留进度）。执行器在无 progress 的新一轮会先 `rm` workspace 与 session 残留再重建。

### 执行模式与盯梢

- `execMode: inproc`（缺省，单进程多 runtime）/ `fork`（每任务子进程，崩溃隔离，事件 IPC 回流）。两条路径语义须保持一致。
- 盯梢三级（2026-09-11 等级放权，`supervision-policy.ts` bashPolicyFor 单点映射）：shadow（task_check 申报 + 白名单外命令均挂审）/ assisted（申报留痕，仅白名单外命令挂审）/ trusted（申报留痕，白名单外命令 bypassWhitelist 直接执行）。裁决以 intervention 事件入审计链。黑名单（sudo/rm -rf/公网外呼）与组合命令三等级硬拒，不经人工；原 `bashApproval` 全局 yaml 开关已退役。

### 密文与脱敏

yaml 中 `enc:v1:` 前缀 = AES-256-GCM 密文，主密钥在环境变量 `DDW_CRED_KEY`（不落盘）。API 返回渠道/员工配置前必须 redact（`***`），PUT 回存时空串/占位符要先剥离再回填已存密钥（见 handlers.ts 的 redact/strip 模式）。

## 提交规范（强制，工具会校验）

由 `packages/mcp-gitlab/src/commit-message.ts` 强制执行，人工提交同样遵守：

- 首行：`<类型>(<分支>): <一句话摘要>`，类型限 feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert，分支 = 目标分支名（本仓直接提交 master）
- 正文必须含 `内容点:` 段落，逐文件一行说明改了什么；「修改文件:」清单由工具自动补全

```
feat(master): webhook 通知渠道接入

内容点:
- src/team/notifier.ts: webhook 渠道报文组装与业务状态校验
- runtime yaml: 通知渠道段配置
```

## 运行配置说明

- `runtime-local.yaml` 是本机在用配置（已被 .gitignore 排除，不入库）；`examples/console-runtime.example.yaml` 是文档样例。两者结构需保持一致，改配置项时同步维护。

## 测试注意事项

- e2e 用 `test/fixtures/faux-agent*.mjs` 预设回复代理，不依赖模型集群；mysql 相关用例看 `test/helpers/mysql.ts`（需要真库时跳过）。
- 全量并发跑时固定 `sleep` 断言不可靠（fs 落盘竞态）——等待外部状态用轮询 + 超时模式。
- 排序语义依赖 `ORDER BY created_at DESC, id DESC`，业务 store 新增记录用 `stores/sql/sortable-id.ts` 的 `sortableId(prefix)`（时间戳+单调序列，同毫秒保序），不要用 randomUUID 做次序键。

## 代码风格要点

- TypeScript NodeNext：相对导入写 `.js` 后缀（实际指向 `.ts`）；使用参数属性（`constructor(private readonly x)`）等非可擦除语法，因此裸 node 必须经 `ts-register.mjs` 钩子运行（`.js`→`.ts` 解析 + typescript 现场转译）。
- 注释密度高、带「为什么」；新接口/字段补注释时说明用户需求背景与日期，与现有风格一致。
- 存储层接口先行：业务侧只依赖 `TaskStore`/`EventStore` 等接口，方言差异收在 `stores/sql/driver.ts`。
