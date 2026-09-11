# P6 · 节点 checkpoint 与盯梢成熟化（2026-09-04）

**Goal**：落实 spec 4.4「节点 checkpoint 事件」定稿——数字员工每完成一个任务项（task 项），以 `task_check` 事件显式申报，形成"清单打勾"审计视图；同时作为二期班组编排的"上游产物就绪"信号。本计划覆盖第一期（checkpoint 最薄实现）；盯梢成熟化的放权策略与班组编排留待后续探讨定稿。

## 背景

- spec 4.4 定稿（2026-09-04）：三级闸门——机器审节点内（acceptance）/ 人审出口（MR/部署）/ 事后审计兜底
- 现状缺口："节点完成"无显式事件，审计台账只能从工具调用序列推断节点推进
- 实现原则：模型自主申报（软编排一致——清单是给模型的 checklist），runtime 校验申报合法性

## Task 1: `task_check` 工具 + 事件类型（runtime）

**Files:**
- Modify: `packages/runtime/src/types.ts`（`AgentEventType` 加 `'task_check'`）
- Create: `packages/runtime/src/task/checkpoint.ts` + `test/checkpoint.test.ts`
- Modify: `packages/runtime/src/runtime/employee-runtime.ts`（任务级工具注入）
- Modify: `packages/runtime/test/e2e-taskpackage.test.ts`（脚本加 task_check 申报 + 事件断言）

**Interfaces:**
- `createTaskCheckTool(deps: { emit: (e: Omit<AgentEvent, 'id'|'ts'|'taskId'|'employeeId'>) => Promise<void>; items?: DevTask[] }): Tool`
  - 参数：`item`（任务项 id，如 T-1）、`result`（acceptance 执行结果摘要）、`passed`（boolean，默认 true）
  - `passed=false` → ok:false "该项未通过，请继续处理后再申报"（防误报完成）
  - `item` 不在 items 列表 → ok:false 附合法项列表
  - 成功 → emit `{ type: 'task_check', summary: '<item> 节点完成：<result>', payload: { item, passed, result } }`
- `EmployeeRuntime`：`TaskInput` 加可选 `items?: DevTask[]`；`runTaskPackage` 透传 `pkg.tasks`；`run` 时 items 非空则向 agent 追加任务级 `task_check` 工具（不污染共享 ToolRegistry）
- [ ] 失败测试 → 实现 → 回归 → 提交

## Task 2: 控制台视图兼容 + 全链路 e2e 更新

**Files:**
- Modify: `apps/console/src/views/AuditLog.vue`（TYPES 加 `'task_check'` 过滤项）
- Modify: `apps/console/src/views/EmployeeLive.vue`（事件徽章/样式兼容新类型，如需）
- Modify: `packages/console-api/test/e2e-full-chain.test.ts`（Faux 脚本在编码段完成时申报 T-1 → 断言 15 个 tool_call 按序 + audit v2 聚合含 task_check + timeline 含 task_check 事件）
- Modify: `apps/console/test/`（若过滤项断言需更新）

**Interfaces:**
- 审计 v2 `GET /api/audit/:taskId` 无需改动：timeline 自动携带 task_check 事件（前端按 type 渲染）
- [ ] 失败测试 → 实现 → 全量回归 → 提交 → **登记《阶段成果总账》P6 第一期**

## P6 第一期验收标准

1. `pnpm -r test` 全绿 + `pnpm typecheck` 干净，全离线不占端口
2. task_check 申报：正常 emit / passed=false 拒绝 / 非法 item 拒绝，各有测试证明
3. 任务级工具不污染共享 ToolRegistry（两次 run 互不串扰）
4. 全链路 e2e：事件流含 task_check 且在编码段之后、MR 之前（按序）
5. 前端过滤/直播兼容新事件类型

---

## 执行记录（2026-09-04 第一期完成）

| 提交 | 内容 |
|---|---|
| `docs(plans): P6 第一期计划` | 本文档 |
| `feat(runtime): task_check 节点申报工具` | AgentEventType 加 task_check；createTaskCheckTool（passed=false 拒绝 / 非法 item 拒绝）；EmployeeRuntime 任务级注入（TaskInput.items，不污染共享 ToolRegistry）；checkpoint.test 5 用例 + e2e-taskpackage 申报断言 |
| `feat(console): task_check 视图兼容` | AuditLog 过滤项 + EmployeeLive 绿色节点徽章样式 |
| `test(console-api): 全链路 e2e 加节点申报` | Faux 脚本编码段后申报 T-1；断言 15 tool_call 按序（task_check 在 commit 后、MR 前）+ audit 聚合 task_check:1 + timeline 弹性断言 |

**实现校准点**：task_check 的工具执行本身也会产生一条 tool_call 事件（pi 映射），tool_call 序列 14→15；timeline 长度随 Faux 轮次弹性断言（不再写死 thinking 数）。

### 验收标准对照

| # | 标准 | 结果 |
|---|---|---|
| 1 | `pnpm -r test` 全绿 + typecheck 干净，全离线不占端口 | ✅ 168 用例（P5 165 + checkpoint 5 − e2e 调整），全量 exit 0 |
| 2 | task_check 三种申报路径各有测试证明 | ✅ checkpoint.test.ts（正常 emit / passed=false 拒绝 / 非法 item 拒绝 / 缺参 / 无清单模式） |
| 3 | 任务级工具不污染共享 ToolRegistry | ✅ extraTools 经 makeAgent 参数注入 agent，registry 未动 |
| 4 | 全链路 e2e：task_check 在编码段后、MR 前 | ✅ e2e-full-chain 按序断言 |
| 5 | 前端过滤/直播兼容新类型 | ✅ AuditLog 下拉含 task_check；EmployeeLive 绿色徽章 |

**结论**：P6 第一期（节点 checkpoint）验收通过。审计台账时间线现可看到"清单打勾"节点申报；二期班组编排的"上游产物就绪"信号就位。盯梢成熟化（放权策略配置化、班组编排）留待后续探讨定稿。

---

## Task 3（第二期）: 盯梢成熟化放权配置 + 节点验收前端视图

**spec 定稿**：4.4「放权配置化」——`SupervisionPolicy.level`（shadow/assisted/trusted），runtime 只管 bash 白名单派生 + 黑名单永全开 + 等级留痕；MR/部署流程闸门留在 GitLab/DevOps 端。

**Files:**
- Create: `packages/runtime/src/security/supervision.ts` + `test/supervision.test.ts`
- Modify: `packages/runtime/src/runtime/employee-runtime.ts`（config.supervision；run() 开始 emit 等级留痕）
- Modify: `apps/console/src/views/TaskDetail.vue`（节点验收区块：listEvents({taskId, type:'task_check'}) 渲染打勾列表）
- Modify: `apps/console/test/`（组件用例）

**Interfaces:**
- `type SupervisionLevel = 'shadow' | 'assisted' | 'trusted'`
- `interface SupervisionPolicy { level: SupervisionLevel; extraCommands?: string[] }`
- `resolveBashWhitelist(policy: SupervisionPolicy | undefined, base: string[]): string[]`——trusted 才合并 extraCommands（去重），否则原样返回
- [ ] 失败测试 → 实现 → 全量回归 → 提交 → 总账更新

### Task 3 执行记录（2026-09-04 完成）

| 提交 | 内容 |
|---|---|
| `docs(spec): 4.4 放权配置化定稿` | 一级一语义表（bash 白名单派生 / 黑名单永全开 / 等级留痕 / MR 流程闸门留平台端） |
| `feat(runtime): SupervisionPolicy` | resolveBashWhitelist（仅 trusted 合并 extraCommands 去重）；config.supervision；run() 开始 emit 等级留痕事件；4 用例 |
| `feat(console): TaskDetail 节点验收视图` | 每个任务项下渲染申报清单（✓ 行 / 待申报）；listEvents(type:task_check)；2 组件用例 |

**实现校准点**：Vue 模板表达式不支持 TS `as` 断言 → 过滤逻辑收敛到 script 的 `checksOf()`；listEvents mock 未给返回值时须兜底空数组（`Array.isArray` 防御）。

### 验收对照（Task 3）

| # | 项 | 结果 |
|---|---|---|
| 1 | shadow/assisted 不放权、trusted 合并去重 | ✅ supervision.test.ts 4 用例 |
| 2 | 等级留痕进事件流 | ✅ employee-runtime.test.ts 首事件断言 `盯梢级别: shadow` |
| 3 | 节点验收视图 | ✅ task-detail.test.ts 2 用例（已申报 ✓ / 待申报） |
| 4 | 全量回归 + typecheck | ✅ 170 用例全绿，exit 0 |

**结论**：P6 第二期（盯梢成熟化配置化 + 节点验收视图）完成。班组编排留二期探讨定稿。
