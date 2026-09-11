# P14 · Playwright 垫片 UI 适配器（G）

日期：2026-09-05 ｜ 状态：进行中
前置：P13 多进程横向扩展已收官（286 用例全绿）。

## 目标

spec 7.3 落地最后一块：**无 API 系统的 UI 兜底通道**。mcp-browser 原语层 P4 已交付
（navigate/click/fill/get_text/screenshot + Playwright/Fake 双驱动），本阶段补 **UI 适配器形态**：
以 Jira 为示范——`jira_get_issue / jira_update_status / jira_add_comment` 工具契约不变，
新增 **ui 实现**（browser 原子动作 + 登录态管理 + 幂等前置读 + 截图审计证据），
与既有 api 实现（JiraTransport）**同契约可互换**——数字员工与任务包零改动，
行内有 API 的系统走 api、Jira/禅道等"钉子户"走 ui 兜底。

## 语义定稿

- **同契约双实现**：工具名/参数/返回结构完全一致；`Tool` 接口加可选标注
  `impl?: 'api' | 'ui'`（spec 7.3"MCP 注册表标注实现类型，垫片覆盖范围一目了然"），
  可选字段零破坏，审计/枚举侧可见。
- **UI 适配器 = browser 原语 + 页面知识常量**：三个操作的流程是确定的（查单=搜索→详情读、
  流转=详情→流转菜单→选目标态、评论=详情→评论框→提交），适配器内聚页面结构知识；
  **选择器集中在适配器顶部一处**（spec 稳定性要点：页面改版只改一处）。
  通用探索仍走 mcp-browser 原语由模型现场决策——两层各司其职。
- **登录态（spec 7.3 凭据与登录）**：`ensureLogin`——导航受保护页检测登录页特征
  （url/title）→ 填账号密码提交 → 重试导航；**storageState 缓存**（per 员工×系统文件），
  冷启动有缓存先 `driver.restoreState` 跳过登录，登录成功 `exportState` 落盘；
  凭据经 `resolveSecret`（明文/`enc:v1:` 两用，P11 概念零新增）。
  试点选型排除项照 spec：验证码/SSO/UKey 系统不接。
- **幂等前置读**：`jira_update_status` 前先查现状态，已是目标态直接 ok
  （`already: true`）——重试/重复分派安全（spec"UI 操作前先读状态"）。
- **失败自愈闭环入口（spec 7.3）**：UI 操作失败报**可读错误**（含当前页面实际文本片段
  + 截图路径）→ 模型自纠偏改道 → 仍失败任务 failed → 盯梢人看截图判断 SOP 过时或真 bug。
- **审计证据**：每个 UI 工具执行留截图，路径进返回 data（`screenshot` 字段）——
  比纯 API 调用更可审计（spec 审计合规要点）。
- **测试全走 FakeDriver**：内存页面模型扩展出 Jira UI 页面（未登录跳登录页、
  登录后放行、详情/流转/评论可编程）；PlaywrightDriver 生产即用不测真网；
  全程离线零新增 npm 依赖（playwright 懒加载定位不变）。

## Task 分解

### T1 Tool 实现类型标注 + 登录态模块
- Modify: `@ddw/runtime` `Tool` 接口加 `impl?: 'api' | 'ui'`（可选，零破坏）
- Create: `mcp-browser/src/login.ts`：`ensureLogin(deps)`（检测→填表→提交→重试；
  storageState 缓存 `restoreState`/`exportState`）
- Modify: `BrowserDriver` 接口加可选 `restoreState?(path)` / `exportState?(path)`；
  FakeDriver 扩展登录页模拟（未登录导航受保护页 → 跳登录页 → 登录后放行）
- Test: 登录态单测（冷启动重登 / 缓存命中跳过 / 凭据错误可读报错）

### T2 Jira UI 适配器
- Create: `mcp-jira/src/ui-adapter.ts`：`createJiraUiTools({ driver, login })`——
  三工具同契约 ui 实现；SELECTORS 常量集中；幂等前置读；截图证据；错误含页面文本
- Modify: `mcp-jira` package.json 加 `@ddw/mcp-browser` workspace 依赖；
  api 工具补 `impl: 'api'` 标注
- Test: 三工具单测（查单/流转含幂等/评论 + 未登录自动重登 + 失败可读错误）

### T3 e2e：数字员工经 UI 通道完成 Jira 流转
- Test: e2e-jira-ui.test.ts——faux 员工用 ui 版 jira 工具
  查单 → 流转 → 评论 一条链（FakeDriver），工具留痕 + impl:'ui' 可枚举 + 截图路径落 data

### T4 收官
- 全仓回归 + typecheck；README（垫片章节）；总账登记 P14；提交

## 验收标准

1. jira 三工具同契约双实现：api/ui 可按系统情况注入互换，数字员工侧零改动
2. 登录态闭环：冷启动自动重登（凭据错误可读报错）+ storageState 缓存命中跳过登录
3. 幂等安全：重复流转同一目标态不产生重复操作（already:true）
4. 审计证据：UI 操作截图路径落工具返回；失败错误含页面文本片段（自愈入口）
5. e2e 一条链：faux 员工经 ui 通道 查单→流转→评论 全程留痕；全仓回归全绿 + typecheck 干净

## 边界（试点期不做）

- 录制固化（record & replay）——spec 定稿为三期前过渡优化，优先级低于推动 MCP 化，不做
- 通用"模型看着页面自由走查"的 UI Agent 循环——mcp-browser 原语已具备，任务包 SOP 层驱动即可
- 验证码/SSO/UKey 系统适配（spec 硬排除项）
- 禅道/老发布系统的更多 UI 适配器（Jira 示范跑通后按系统照抄模式）
