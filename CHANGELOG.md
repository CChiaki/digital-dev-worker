# 更新日志

面向使用者的功能变化记录，按日期倒序。架构决策与设计细节见 `docs/superpowers/specs/`，日常开发见 `docs/开发指南.md`。

## 2026-09-11

### 新增

- **API 准入闸**：具名 Bearer token 鉴权（`auth.tokens` 段，token 支持 `enc:v1:` 密文）、监听地址收口（`bindHost`）、接口限流与请求体大小上限；`cli.ts token <操作者名>` 一键签发并落盘 yaml
- **盯梢三级放权重构**：`shadow`（节点申报 + 白名单外命令均挂审）/ `assisted`（申报留痕，仅白名单外命令挂审）/ `trusted`（留痕，白名单外命令直接执行）单调放权梯度；黑名单与组合命令三等级一致硬拒，不经人工
- **韧性闭环**：任务级看门狗（`taskTimeoutMs`，挂审待放行 4 倍宽限）、模型调用超时 + 重试 + fallback、启动孤儿任务扫描与 `force-reset`、优雅停机
- **磁盘治理**：`retention.workspaceDays` 按 TTL 清扫终态任务 workspace/session（审计事件一条不删）
- **运营增强**：token 用量记账、审计链每日自动校验 + 通知渠道告警群发、任务计划逐项失败自动重试（`retryPerItem`）
- **凭据巡检扩展**：doctor 覆盖员工模型密钥密文化、API 鉴权配置、存储连通性（sqlite/mysql 双驱动）

### 修复

- 假 done 事故：任务收尾错误检测 + 工具结果体积封顶，防止异常被静默吞掉导致任务假完成
- OceanBase/MySQL 方言：JSON 列 LIKE 匹配差异改应用层过滤；业务记录次序键改时间戳单调序列，消除同毫秒排序偶发乱序

## 2026-09-10

### 新增

- **消息中心实时化**：轮询改 SSE 推送（未读消息 / 待人工放行 / 待审 Skill 三计数），跨方言兼容修复；消息服务端过滤 + 分页
- **白名单外命令人工放行**：员工执行白名单外命令挂起等人工裁决（显示命令原文），同任务同命令记忆放行；前端零改动复用盯梢闸门链路，inproc/fork 双模式接通
- **智能生成质量强化**：注入能力矩阵 + MCP 工具清单，生成方案优先调用已接入工具、绝不自编 API；verify 阶段规则修正（commit 节点禁用本地 git log 校验）
- **通知渠道 `yanxun` 类型**：企业内部 sendRobotText 风格机器人接入，成功/失败全量留痕（推送流水号可追溯）
- **推送留痕表 `ddw_push_logs`**：每条消息 × 每渠道逐条落 {状态、失败原因、流水号}，管理台新增「推送记录」页
- **智能生成留痕表 `ddw_generations`**：成功记方案与 yaml、失败记错误，可查可复盘
- **受控 bash 扩充**：白名单扩至 56 常用命令，单命令超时可配（`bashTimeoutMs`）
- **`maxTurns` 配置化进 yaml**（缺省 40）：runtime-config → pipeline → inproc/fork 全链路透传，超限失败原因带生效上限值

### 修复

- 员工专属模型绑定路由错误（误挂 chat 致绑定即失效），改挂 code 路由，双执行链路一致
- 失败任务可编辑重跑直达待分派（重提交回 pending 而非 draft）
- 人工放行角标数值不准（幽灵待审计入）与消退延迟（裁决事件即推 counts）

## 2026-09-09 · 存储企业化

- 业务存储抽象为 `TaskStore`/`EventStore` 等接口，sqlite（缺省）/ mysql 双驱动，全部业务表 `ddw_*`，Driver 抽象抹平方言差异
- 审计事件 hash 链成链，篡改可检测；`cli.ts migrate` 存量数据一次性导入
- 管理台多岗位员工支持（岗位即技能库，技能按任务岗位精准注入）

## 2026-09-08 及更早（核心能力形成期）

- **任务包驱动**：yaml 工单固化入库，plan 逐项驱动，验收项系统亲自执行以退出码为准，失败断点续跑
- **班组编排**：多任务依赖 DAG、并行分派、失败阻断下游、岗位匹配调度
- **盯梢闭环**：shadow 级节点申报 + 人工放行闸门，裁决入审计链
- **Skill 库**：分类管理、入库严格审查流、员工完成任务自动蒸馏候选技能入待审库
- **双协议模型网关**：openai-completions / anthropic-messages，chat/code/review/test 分路由，超时重试 + fallback
- **双防线执行层**：受控 bash（白名单/黑名单/禁组合命令）+ SandboxBackend（Noop/Bwrap/Docker）
- **执行模式双轨**：inproc（单进程多 runtime）/ fork（每任务子进程，崩溃隔离，事件 IPC 回流）
- **凭据密文化**：`enc:v1:` AES-256-GCM，主密钥环境变量注入不落盘，API 回显全量脱敏
- **管理台前端**：Vue3 + Element Plus + Tailwind v4，任务中心/员工直播/人工放行/审计台账/Skill 库/通知渠道
- **离线交付链**：离线打包 → 预演 → 安装 → 冒烟 → doctor 巡检 → systemd 常驻
