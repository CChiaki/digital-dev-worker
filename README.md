# 数字开发分身（digital-dev-worker）

数字员工研发一体化平台（DDW）——**面向金融、政务等强合规行业的离线数字员工平台：每个数字员工拥有独立身份与专属模型，接入企业既有研发工具链（GitLab / Jira / CI / 部署 / 验证环境），从接单、编码、提交、测试到发布端到端完成研发任务，全程可盯梢、可审计、可沉淀。**

- 仓库：[github.com/CChiaki/digital-dev-worker](https://github.com/CChiaki/digital-dev-worker)
- 许可证：[MIT](LICENSE)

- 全程支持**内网完全离线**部署：模型走私有化集群（OpenAI 兼容 / Anthropic 双协议网关），数据、模型、工具链三样全在内网，零公网依赖
- 产品代码 TypeScript（pnpm monorepo）；执行内核基于 [pi](https://github.com/badlogic/pi-mono)（fork 兜底 + 供应链准入）
- 产品与投资视角说明见 [docs/上手/产品说明.md](docs/上手/产品说明.md)；总体设计与特性 spec 见 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`

## 核心特性

- **任务包驱动**：一份 yaml 工单（repo / 逐任务 files + requirement + acceptance / plan 计划步骤 / 汇报通道）固化入库 → 数字员工接单执行；计划逐项驱动，验收项由系统亲自执行、以退出码为准，失败断点续跑
- **班组编排**：多任务依赖 DAG、并行分派、失败阻断下游；调度按「任务岗位 ∈ 员工岗位」自动分派，支持点名指定
- **盯梢放权三级**：shadow（关键节点阻塞等人工放行）→ assisted（留痕不阻塞）→ trusted（自主执行），信任渐进式开放；每次裁决以 intervention 事件入审计链
- **岗位即技能库**：Skill 分类即岗位，员工挂岗位（支持多岗），技能按任务岗位精准注入；员工每完成一个任务自动蒸馏候选技能入待审库——组织知识滚雪球
- **能力注册表**：kind → 工具集声明式绑定（dev/test/commit/devops 预设），数字员工拿到的工具严格受控，运行中修改即时生效
- **双防线执行层**：工具层软防线（白名单/黑名单/禁链式）+ `SandboxBackend` 硬防线（`Noop` 直通 / `Bwrap` OS 沙箱 / `Docker` 容器），切换 = 注入一项
- **有 API 直接对接，无 API 用 Playwright 垫片**：同一工具契约 api/ui 双实现可互换，Jira 等无 API「钉子户」走 UI 兜底（登录态维护、幂等防重、截图取证）
- **双协议模型网关**：openai-completions / anthropic-messages；chat/code/review/test 四类调用分路由，超时重试 + fallback 自动切换；支持员工一人一模型一 key
- **凭据密文化**：`enc:v1:`（AES-256-GCM）密文落盘，主密钥经环境变量注入不落盘；API 回显全量脱敏
- **存储企业化**：业务端只依赖 `TaskStore`/`EventStore` 接口，sqlite（缺省）/ mysql 双驱动，全业务表 `ddw_*` 同源落库；审计事件 hash 链成链，篡改可检测
- **执行模式双轨**：`inproc`（缺省，单进程多 runtime）/ `fork`（每任务子进程，崩溃隔离，事件 IPC 回流），语义一致
- **离线交付链**：离线打包 → 一键预演 → 安装 → 冒烟 → doctor 巡检 → systemd 常驻，配套验收清单与回滚预案

## 整体架构

```
┌───────────────────────────┐
│  管理台前端 apps/console   │  Vue3 + Element Plus + Tailwind v4
│  任务中心/员工直播/人工放行 │  SSE 实时推送 + 轮询兜底
│  审计台账/Skill 库/通知渠道 │
└─────────────┬─────────────┘
              │ /api（同源反代，可选 Bearer token 鉴权）
┌─────────────▼─────────────────────────────────────────────┐
│              console-api（packages/console-api）           │
│  任务池固化 ─► scheduler 调度（依赖 DAG / 岗位匹配）        │
│  人工放行闸门 ─ 盯梢三级（shadow/assisted/trusted）         │
│  审计 hash 链 ─ 事件直播 SSE ─ 通知渠道 ─ Skill 蒸馏        │
│  存储中间层：sqlite（缺省）│ mysql 双驱动，ddw_* 业务表     │
└───────┬───────────────────────────────┬───────────────────┘
        │ execMode: inproc（单进程）     │ execMode: fork（每任务子进程，IPC 回流）
┌───────▼───────────────────────────────▼───────────────────┐
│         执行内核 @ddw/runtime（packages/runtime）          │
│  EmployeeRuntime 对话循环 ─ 双协议模型网关 ─ 受控 bash      │
│  （白名单/黑名单/禁链式 + Bwrap/Docker 沙箱硬防线）          │
└───────┬───────────────────────────────┬───────────────────┘
        │ 私有化模型集群                  │ MCP 远端工具（Transport 接口）
        │ （OpenAI 兼容/Anthropic）       ▼
        │                    GitLab/Gitea · Jira · CI · 部署 · 验证环境
        │                    （api 实现 / Playwright UI 垫片）
        ▼
   全部内网，零公网依赖
```

## 快速开始

```bash
# 1. 安装依赖（Node ≥ 20.5，pnpm ≥ 9）
pnpm install

# 2. 回归验证（全仓 630+ 用例全绿，全程离线）
pnpm -r test
pnpm -r typecheck

# 3. 配置运行时 yaml
cp examples/console-runtime.example.yaml runtime-local.yaml
#    按注释改：模型路由 routes / 代码托管 forge / 存储 storage 段
#    （凭据可明文先跑通，再用 enc:v1: 密文：见下方「凭据加密」）

# 4. 启动控制台（端口 3100）
node --import packages/console-api/src/team/ts-register.mjs \
  packages/console-api/src/cli.ts --port 3100 --data ./data \
  --runtime runtime-local.yaml

# 5. 启动管理台前端（开发模式，端口 5173）
pnpm dev:web
```

启动后：管理台粘任务包 yaml 固化（支持智能生成 → 预览 → 草稿 → 发布）→ 调度器按依赖/岗位自动分派 → 数字员工执行（plan 逐项 + 节点申报）→ 「员工直播」实时可见 → 审计 hash 链可校验 → 任务完成自动蒸馏候选 Skill。

一键演示（预置班组协作/盯梢放行场景）：`node scripts/demo.mjs`；`--mock` 用 faux 预设回复，不依赖模型集群。

### 凭据加密（可选但生产必配）

```bash
export DDW_CRED_KEY=$(node packages/console-api/src/cli.ts cred key)  # 生成主密钥，注入启动环境
node packages/console-api/src/cli.ts cred enc '<真实apiKey>'           # 输出 enc:v1:... 填入 runtime yaml
```

yaml 中 `apiKey`/`password`/`token` 明文与 `enc:v1:` 密文两用；密文缺主密钥/错 key/篡改 = **启动即失败**。

### 巡检

```bash
node packages/console-api/src/cli.ts doctor --data ./data \
  --runtime runtime-local.yaml --probe
# 检查项：Node 版本 / 数据目录可写 / 存储连通 + 审计 hash 链完整性 / 配置+凭据解密 /
#         主密钥格式 / bash 白名单命令在 PATH / （--probe）模型集群连通
```

## 目录结构

```
packages/
  runtime        @ddw/runtime   数字员工运行时内核（pi 封装层，双协议模型网关）
  mcp-gitlab     GitLab 工具：建分支/提交文件/MR/查 MR/查文件（含 Gitea 适配层）
  mcp-jira       Jira 工具：查单/流转/评论（api/ui 双实现，UI 垫片走 Playwright）
  mcp-ci         CI 工具：触发构建/查状态/等终态/日志
  mcp-deploy     部署工具：部署 test/staging 等（local/ssh 产物复制+重启）
  mcp-testenv    验证环境工具：健康检查/取页面
  mcp-browser    浏览器原子动作：navigate/click/fill/get_text/screenshot
  console-api    控制台 API：任务池/调度/员工档案/岗位与 Skill 库/能力注册表/
                 事件直播(SSE)/审计台账/消息中心/通知渠道（sqlite/mysql 双驱动）
  spike-pi       P0 可行性验证 spike（归档）
apps/
  console        管理台前端（Vue3 + element-plus + Tailwind v4）
examples/
  task-package.example.yaml        任务包样例（数字员工的「工单」）
  console-runtime.example.yaml     一体化运行时配置样例
  console-runtime-demo.yaml        本地演示配置样例（配 Gitea）
  demo/                            一键演示预置场景（task-backend → task-frontend 依赖编排）
docs/
  上手/ 部署/ 运维/ 参考/           面向使用者的公开文档（见下文索引）
  待办清单.md                      架构体检遗留项
  开发指南.md                      贡献者指南
  internal/                        内部资料（发布时排除）
scripts/
  offline-pack.mjs / offline-install.sh / rehearsal.mjs   离线交付链
  demo.mjs                         一键演示
```

## 技术栈

| 层 | 技术 |
|---|---|
| 执行内核 | TypeScript、Node ≥ 20.5、[pi](https://github.com/badlogic/pi-mono)（agent 循环）、Playwright（UI 垫片） |
| 模型网关 | OpenAI 兼容协议 / Anthropic 协议双适配 |
| 控制台 API | Node 原生 http、SSE、sqlite（`node:sqlite`）/ mysql2 双驱动、AES-256-GCM 凭据密文 |
| 管理台前端 | Vue3 + Element Plus + Tailwind v4 + Vite |
| 工具集成 | MCP（Transport 接口，stdio/http），GitLab/Jira/CI/部署/验证环境/浏览器 |
| 交付 | 离线打包（pnpm store 全量携带）、install.sh、doctor 巡检 CLI、systemd 单元样例 |

## 企业接入配置点（对接自有环境仅差这些）

| 接入点 | 位置 | 内容 |
|---|---|---|
| 模型集群 | `ModelGateway` 的 `RouteConfig` | baseUrl / apiKey / 模型名（chat/code/review/test 分路由，双协议） |
| GitLab / Jira | `FetchGitLabTransport` / `FetchJiraTransport` | baseUrl + token |
| DevOps 平台 | `CiTransport` / `DeployTransport` / `TestenvTransport` 生产实现 | 平台 API 地址 + 凭据 |
| 员工凭据 | MCP 凭据库（一期加密配置） | 数字员工在各系统独立账号 |
| 工作区隔离 | `ControlledBash` 的 `backend` | 试点 `new BwrapBackend(...)`，生产 `new DockerBackend(...)` |
| 控制台存储 | runtime yaml 的 `storage:` 段 | `driver: sqlite`（缺省）或 `mysql`；存量数据 `cli.js migrate` 一次性导入 |

## 文档索引

### 上手

| 文档 | 内容 |
|---|---|
| [docs/上手/产品说明.md](docs/上手/产品说明.md) | 产品与投资视角：行业痛点/解法价值/差异化/落地路径 |
| [docs/上手/本地演示环境搭建.md](docs/上手/本地演示环境搭建.md) | 本地演示环境 runbook：云端模型 + Docker Gitea 跑通完整开发任务 |

### 部署

| 文档 | 内容 |
|---|---|
| [docs/部署/试点部署手册.md](docs/部署/试点部署手册.md) | 离线交付 runbook（sqlite 版）：安装/凭据/巡检/systemd/验收清单/故障排查/回滚 |
| [docs/部署/内网部署手册-MySQL.md](docs/部署/内网部署手册-MySQL.md) | 内网部署 runbook（MySQL 版）：MySQL 准备/离线安装/凭据/storage 配置/migrate/巡检/systemd/验收/备份回滚/排查表 |

### 运维

| 文档 | 内容 |
|---|---|
| [docs/运维/fork模式运维篇.md](docs/运维/fork模式运维篇.md) | fork 执行模式运维：日常观测/OOM/挂起/IPC 断连处置矩阵/inproc 取舍 |
| [docs/运维/备份恢复演练手册.md](docs/运维/备份恢复演练手册.md) | 备份对象清单 + 恢复八步演练 + 常见恢复坑（每季度演练一次） |

### 参考

| 文档 | 内容 |
|---|---|
| [docs/参考/API文档.md](docs/参考/API文档.md) | 控制台 API：鉴权约定 + 全资源分组路由表 |
| [docs/开发指南.md](docs/开发指南.md) | 贡献者指南：常用命令/包职责/配置全链路/提交规范/代码风格 |
| [CHANGELOG.md](CHANGELOG.md) | 更新日志 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南：环境要求/开发约定/提交规范/PR 流程 |
| [docs/待办清单.md](docs/待办清单.md) | 架构体检产出的待完善项（按优先级分档） |
| `docs/superpowers/` | 总体设计与各特性 spec/实施计划 |

> 内部资料（演示剧本、试点方案一页纸、阶段成果汇报、更新日志）存放于 `docs/internal/`，开源发布时排除，索引不在此列出。
