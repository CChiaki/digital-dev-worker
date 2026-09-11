# 控制台 API 文档（骨架）

> 2026-09-11 P2 产品批新增骨架：先覆盖资源分组与关键语义，字段级 schema 以
> `packages/console-api/src/http/handlers.ts`（路由唯一事实源）与前端 `apps/console/src/api.ts` 为准，
> 后续按需展开。

## 通用约定

- Base URL：`http://<主机>:3100/api`（前端同源反代）。
- **鉴权**（2026-09-11）：yaml `auth.tokens` 非空即启用——请求带 `Authorization: Bearer <token>`
  或 query `?token=<token>`（SSE EventSource 无法带头部，必须支持 query）；
  匹配则 `operator`（token 的 name）注入请求上下文，干预/配置变更事件留痕「谁操作的」。
  未配置 auth 段 = 鉴权关闭（内网部署需配 `bindHost` 收口）。
- 响应：`200` 成功；`4xx` 客户端问题（400 参数/404 不存在/409 状态冲突/413 超限/429 限流/401 未鉴权）；`5xx` 服务端。
- SSE：两个流端点均 `text/event-stream` + 15s 空闲心跳（反代须关缓冲，响应头已带 `X-Accel-Buffering: no`）。

## 任务（核心）

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/tasks` | 任务池列表（`?status=done,failed` 多值、`?claimedBy=` 过滤）；含分派序 createdAt、planProgress、tokenUsage |
| POST | `/api/tasks` | 固化任务包（body = yaml 原文，text/plain）；同 taskId 重提 = upsert 重跑（清执行态） |
| POST | `/api/tasks/parse` | 智能生成：自然语言 → yaml（不落库，留痕 ddw_generations） |
| GET | `/api/tasks/:id` | 任务详情（含 result 执行结果、逐项进度、token 用量） |
| POST | `/api/tasks/:id/publish` | 发布进调度池（可先 `/assign` 点名员工） |
| POST | `/api/tasks/:id/resume` | 失败计划断点续跑（保留进度，谁失败谁继续） |
| POST | `/api/tasks/:id/force-reset` | 强制重置：任意状态回 pending（在途执行先中性化） |
| POST | `/api/tasks/:id/checks/:item/review` | 人工放行/驳回节点（shadow 级闸门唤醒） |
| POST | `/api/tasks/:id/checks/:item/void` | 作废幽灵/过期待审（intervention voided 留痕） |

## 事件与直播（SSE）

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/events` | 事件查询（`?taskId=`、`?since=ts` 增量） |
| GET | `/api/events/stream` | agent 事件直播：`?taskId=/employeeId=` 过滤 + `?since=` 断线续播；事件名 `agent-event` |
| GET | `/api/messages/stream` | 消息推送：counts 角标 + message 新消息；挂断即退订 |
| GET | `/api/checks` / `/api/checks/history` | 待放行队列 / 放行历史（含作废） |

## 审计

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/audit` | 审计台账：全事件倒序 + byType 计数 + 分页（`?type=&limit=&offset=`）+ `lastIntegrity` 最近校验 |
| POST | `/api/audit/verify` | 立即全链 hash 校验（返回 `{ok, at, total, brokenAt?}`） |
| GET | `/api/audit/:taskId` | 任务级聚合：状态 + 时间线 + 工具统计 |

## 员工 / 能力 / Skill / 渠道

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET/POST | `/api/employees` | 名册列表 / 新增（`model` 段 = 员工专属模型一 key，apiKey 支持 enc:v1） |
| GET/PUT/DELETE | `/api/employees/:id` | 档案维护（密文 redact/回填模式：`***` = 保留原值） |
| GET/POST/PUT | `/api/capabilities`（+/`:kind`）、`/api/capabilities/meta` | 能力注册表（kind → 工具集映射）+ 元数据（builtin/mcp 清单） |
| GET/POST/PUT/DELETE | `/api/skills`、`/api/skill-categories` | Skill 库（草稿 → 待审 → approved 拒绝流，人工终审 reviewedBy） |
| GET/POST/PUT/DELETE | `/api/notification-channels`（+ `/:id/test`） | 通知渠道（钉钉加签/自定义机器人 token 密文入库，回显 `***`） |
| GET | `/api/mcp-servers` | MCP server 连接状态与工具发现 |

## 消息与推送

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/messages`（+ `/:id/read`、`/read-all`） | 消息中心（audit_alarm/任务通知） |
| GET | `/api/push-logs` | 消息 × 渠道推送留痕（渠道静默丢投排查） |
| GET | `/api/generations` | 智能生成记录 |
