# fork 模式运维篇

> 2026-09-11 P2 产品批新增。fork 模式 = `runtime-local.yaml` 配 `execMode: fork`：
> 每个任务 fork 一个 worker 子进程跑完即退，崩溃隔离（员工进程崩不拖死控制台），
> 事件经 IPC 回流主进程统一落库（hash 链保序不变）。inproc/fork 两条路径语义一致。

## 1. 日常观测

| 观测点 | 入口 | 说明 |
| --- | --- | --- |
| 任务执行日志 | `<workspaceRoot>/<员工id>/<taskId>/worker.log` | worker stdout/stderr 按任务 tee 归集（2026-09-11），并发任务不再混流；随 retention TTL 一并清理 |
| 主进程日志 | `pm2 logs <应用名>`（或 systemd journal） | worker 输出同时原样转发（带 `[ddw:worker <taskId>]` 前缀）；调度/看门狗/清扫日志 `[ddw:模块]` 前缀，`DDW_LOG_LEVEL=debug` 可开模块级细节 |
| 任务事件流 | 控制台「员工直播」/ `GET /api/events?taskId=` | 计划逐项进度、工具调用、token 用量 report 全留痕 |

## 2. 故障处置矩阵

### worker OOM / 被内核杀（exit signal=SIGKILL）
- 现象：任务 failed，result 为 `执行进程异常退出: exit code=null signal=SIGKILL`。
- 定位：`worker.log` 尾部看是否大文件/长输出撑爆内存；`dmesg | grep -i oom` 确认内核记账。
- 处置：正常场景 `POST /api/tasks/:id/force-reset` 重置回 pending 重跑；根治看是哪一步产物过大（拆任务包、收紧 verify 输出）。

### worker 无响应挂起（模型 hang / 死循环）
- 防线：yaml `taskTimeoutMs`（建议 2h）到点主进程 kill 子进程（TERM → 5s 宽限 → KILL），
  任务落 failed「任务超时」；DB 收割与子进程 kill 双保险，先到者生效。
- **挂审宽限**：任务在等人工放行（待放行队列非空）时不计时（4 倍宽限）——等人工不是 hang。
- 处置：若看门狗已收割，走「失败续跑」（`POST /api/tasks/:id/resume`，保留进度断点续）；
  若无超时配置且已挂死，`force-reset` 强制重置。

### IPC 断连（主进程重启 / worker 意外退出）
- 主进程重启：在途任务由**下次启动孤儿扫描**接管（claimed/running → failed「进程重启中断」，可续跑/重置），
  SIGTERM 优雅停机与孤儿扫描双保险。
- worker 半途退出：事件已实时回流落库（不丢），任务按 crashOutcome failed；`worker.log` 看退出原因。

### 闸门挂起（shadow 级 task_check 等人工放行）
- 不是故障：等放行是设计语义。控制台「人工放行」页处理；
  任务已终态但待审条目残留 → 「作废」（`POST /api/tasks/:id/checks/:item/void`，intervention 留痕）。

## 3. 与 inproc 的取舍

| 维度 | inproc（缺省） | fork |
| --- | --- | --- |
| 部署 | 单进程 | 主进程 + 每任务子进程 |
| 崩溃影响 | 任务异常可拖垮主进程 | 子进程崩，控制台无感 |
| 资源 | 共享 | 每任务独立内存（并发多时内存放大） |
| 切换 | 改 `execMode` 重启即可，任务包/接口/审计语义完全一致 | |

排查 fork 特有问题时，可临时切回 inproc 对比（同任务包重提即可对照）。
