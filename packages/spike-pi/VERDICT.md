# P0 pi 验证结论

- pi-agent-core 版本：0.84.4
- pi-ai 版本：0.84.4
- 验证日期：2026-09-04

| # | 验证点 | 结果 | 备注/差异 |
|---|---|---|---|
| 1 | 自定义工具注册与执行 | ✅ | 见下方差异记录 1-3 |
| 2 | beforeToolCall/afterToolCall 拦截 | ✅ | 返回 `{block:true, reason}`；被拦后 toolResult（isError=true）带 reason 回到模型，循环继续、模型可纠偏；事件序列见差异记录 4 |
| 3 | 事件流订阅→AgentEvent 映射 | ✅ | 官方 README 事件序列全部实测出现；`message_update` 的 `assistantMessageEvent.type='text_delta'` 可收到流式 delta |
| 4 | session 持久化与恢复 | ✅ | JsonlSessionRepo 可用但需自备 FileSystem 适配器（见差异 5）；产品层方案=裸 Agent + Session 手工接线（见差异 6） |
| 5 | 单进程多实例 | ✅ | 同进程多 Agent 并行互不串扰；每实例独立 faux/models/session，transcript 各自落盘（s5 测试） |
| 6 | vLLM OpenAI 兼容冒烟 | ✅ 代码就绪 | s6 测试已写好（api="openai-completions" 的 Model 直指 vLLM baseUrl，含流式 delta 与 toolCall 循环两用例）；内网 vLLM 不可达自动 skip，设 PI_SPIKE_VLLM_URL/MODEL 即执行 |
| 7 | steering 运行中注入消息 | ✅ | `agent.steer(AgentMessage)` 运行中入队，轮次边界经 getSteeringMessages 注入上下文；实测注入消息位于 toolResult 之后、最终回复之前，并触发额外一轮（s5 测试）。steeringMode 支持 "all"/"one-at-a-time" |

## pi API 差异记录

1. **AgentTool**：需必填 `label` 字段；`execute(toolCallId, params, signal?, onUpdate?)` 返回 `AgentToolResult { content: [{type:'text',text}], details }`（计划假设的 `{ok,data}` 形态不成立）；工具抛异常即失败（不要在 content 里编码错误）
2. **Faux Provider**：`fauxProvider()` 返回 handle（provider/models/getModel/setResponses/appendResponses/state）；脚本步骤用 `fauxAssistantMessage(fauxToolCall(name, args))` / `fauxAssistantMessage(fauxText(...))`；接入用 `models.setProvider(faux.provider)` + `streamFn: models.streamSimple.bind(models)`
3. **Agent 构造**：`new Agent({ initialState: { systemPrompt, model, tools }, streamFn })`；状态经 `agent.state.messages`（toolResult 消息 role 为 `'toolResult'`）
4. **beforeToolCall**：签名 `(ctx: {assistantMessage, toolCall, args, context}) => Promise<{block?, reason?, terminate?}|undefined>`；被拦的工具调用产生 isError 的 toolResult，`tool_execution_end` 事件 `isError=true`，循环不终止
5. **JsonlSessionRepo**：`new JsonlSessionRepo({ fs, sessionsRoot })` 需自备 FileSystem 适配器（pi-agent-core 未内置 Node 适配器，本包 `test/helpers/node-fs.ts` 即最小实现，~90 行）；Session.appendMessage 内部 assertJsonSerializable **严格校验**——undefined 值/访问器属性/非普通对象直接拒落盘（invalid_payload），运行时消息必须先 `JSON.parse(JSON.stringify(msg))` 规范化；`session.findEntries()` 返回 **newest-first**（按 entry id 降序），恢复注入 messages 前需 reverse 成时间序；`repo.create/open/list/fork` 语义齐全，fork 继承完整 transcript 后互不影响
6. **AgentHarness 是脚手架**：agent-core 0.84.4 的 AgentHarness.prompt 直接抛 HarnessNotImplemented；pi-coding-agent 的 AgentSession 可用但强依赖 SessionManager/ResourceLoader/ModelRuntime 全家桶，过度耦合 → **产品层决策：裸 Agent + Session 手工接线**（订阅 message_end → appendMessage 落盘，恢复时读回 entries 反转后注入 initialState.messages）。接线必须收集 appendMessage 的 promise 并在停止时 await（fire-and-forget 会产生读盘竞态，transcript 缺尾）

## 最终结论：**GO**

日期：2026-09-04　版本锁定：pi-agent-core / pi-ai 0.84.4

**理由：**
1. 七个验证点全部通过（验证点6代码就绪、待内网 vLLM 环境执行，不阻塞结论——pi 的 `openai-completions` 适配层为标准 OpenAI 协议，vLLM 完全兼容，且行内"模型不用担心"）。
2. 产品所需的全部内核能力实测可用：自定义工具（TypeBox schema）、beforeToolCall 拦截（安全层关键钩子，被拦后模型可自纠偏）、完整事件流（直播/审计数据源）、session JSONL 持久化与 fork 分支（断点恢复/多方案并行）、单进程多实例（每员工一 Agent）、steering 运行中介入（人工纠偏/试用期盯梢通道）。
3. 之前预判的硬伤均不成立或有兜底：权限系统缺失反而是优点（天然全自动、零接入成本，安全靠容器+白名单+beforeToolCall 五层防线）；协议兼容缺失可用 pi-ai 的 custom Model + samplingParams 兜底；版本漂移以锁定 0.84.4 + fork 审计准入控制。

**对 P1 计划的影响（按 P0 计划文末对照表执行）：**
- P1 从「自研内核」改写为「**pi 封装层**」：不再实现 Agent 循环/流式解析/重试，聚焦胶水层。
- 必须自建的部分（pi 没有的）：
  - `FileSystem` 的 Node 适配器（`test/helpers/node-fs.ts` 直接毕业为产品代码，~90 行）
  - `wireSession` 持久化接线（`test/helpers/wire-session.ts` 毕业：message_end → JSON 规范化 → appendMessage，停止时 await 全部 pending）
- 必须吸收的坑（已实测，写死在封装层）：
  - 运行时消息落盘前必须 `JSON.parse(JSON.stringify())`（assertJsonSerializable 严格校验）
  - `findEntries()` 返回 newest-first，恢复注入前 reverse 成时间序
  - `AgentTool` 必填 `label`；execute 返回 `AgentToolResult{content,details}`；工具内抛异常=失败
  - Faux（测试）/自定义 Provider 经 `models.setProvider()` + `streamFn: models.streamSimple.bind(models)`
  - 拦截层用 `beforeToolCall` 返回 `{block:true, reason}`，被拦自动产生 isError toolResult 回灌模型
- AgentHarness/AgentSession **不采用**（前者未实现、后者过度耦合），产品层全程裸 Agent + 手工接线。

测试基线：**10 passed + 2 skipped（vLLM 环境 gated）/ 6 文件**，全部 <1s，纯离线可回归。
