# 内网部署手册 · MySQL 存储版（runbook）

> 面向运维/交付工程师：银企业内网环境从零部署数字AI研发人员，**数据源使用 MySQL**（P17 存储企业化：
> 任务/事件/员工/Skill/能力/消息/通知渠道 8 张 `ddw_*` 表全部落 MySQL，部署运行时不出现 JSON 数据文件）。
> 与《[试点部署手册.md](./试点部署手册.md)》（sqlite 版）配套阅读；本文只覆盖 MySQL 专项差异，并做完整串联。
> 交付前可在有网开发机预演 1–7 步：`node scripts/rehearsal.mjs`。

## 0. 方案总览

```
┌────────────┐   /api 反代    ┌─────────────────────┐      ┌──────────────┐
│ 管理台前端  │ ─────────────▶ │  console-api (Node) │ ───▶ │ MySQL 8.0+   │
│ (静态产物)  │                │  端口 3100          │      │ 8 张 ddw_* 表 │
└────────────┘                │  systemd 常驻       │      └──────────────┘
                              └──────┬──────────────┘
                                     │ 执行任务时产出
                                     ▼
                        <dataDir>/workspace/<员工>/<taskId>   （员工代码工作区，文件）
                        <dataDir>/sessions/<员工>/…           （会话 jsonl，文件）
                        <dataDir>/audit-heads.jsonl           （审计链头快照，文件）
```

**数据归属一览**（MySQL 化后仍属文件的三类，均为"工作文件/存证"而非业务数据）：

| 内容 | 位置 | 说明 |
|---|---|---|
| 业务数据（任务池/审计事件/员工档案/Skill 库/能力注册表/消息/通知渠道） | **MySQL** `ddw` 库 8 张 `ddw_*` 表 | 备份走 mysqldump |
| 员工代码工作区 | `<dataDir>/workspace/…` | 员工写代码的物理目录，天然文件 |
| 员工会话记录 | `<dataDir>/sessions/…` | agent 会话 jsonl，天然文件 |
| 审计链头快照 | `<dataDir>/audit-heads.jsonl` | 库外存证（篡改暴露凭证），天然文件 |

**组件与端口**：

| 组件 | 端口 | 说明 |
|---|---|---|
| console-api（后端 + 调度 + 执行） | 3100 | systemd 常驻，生产核心 |
| 管理台前端 | 80/443 或 5173 | 构建产物走 nginx 托管（§8）；试点可 `vite` 直跑 |
| MySQL | 3306 | 独立库 `ddw`，专用账号最小授权 |

## 1. 前置条件（全部逐项核验后再动手）

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node.js | ≥ 20.5（推荐 22 LTS；代码用裸 node 直跑 TS，内置解析钩子） | `node -v` |
| pnpm | ≥ 9（内网无网时从有网机带 tgz，见 §3） | `pnpm -v` |
| MySQL | **≥ 8.0**（验证基线：开发机 MySQL 8.4；InnoDB + utf8mb4） | `mysql --version` |
| bash / git / node / npm / npx / python3 | 全部在 PATH（数字员工执行环境白名单，doctor 会检） | `which git node npm npx python3` |
| 磁盘 | 安装 + workspace 预留 ≥ 2 GB（含源码/依赖/测试临时/工作区） | `df -h .` |
| 端口 | 3100 未占用；到 MySQL 3306、模型集群端点、代码托管端点网络可达 | `ss -tlnp \| grep 3100` |
| 系统账号 | 建议专用 `ddw` 用户（`useradd -r -m ddw`） | — |

**需向 DBA/网络组申请的清单**（一次性）：

1. MySQL 空库一个：库名建议 `ddw`，`CHARACTER SET utf8mb4`（建库语句见 §2）。
2. 应用专用 MySQL 账号（最小授权，见 §2.3）。
3. 出方向网络开通：MySQL 3306、模型集群 API 端点、内网 GitLab/Gitea、（如用）Jira/DevOps 平台。

## 2. MySQL 数据库准备（DBA 操作）

### 2.1 建库

```sql
CREATE DATABASE ddw CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

> 8 张业务表由应用**首次启动自动创建**（`ensureSchema`，幂等），运维无需手工建表；
> 表均为 `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`。**不需要**预先导入任何 schema。

### 2.2 专用账号与最小授权

```sql
CREATE USER 'ddw'@'10.%' IDENTIFIED BY '<强口令>';   -- 按内网网段收紧 host
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, DROP, REFERENCES
  ON ddw.* TO 'ddw'@'10.%';
-- DROP 仅为运维重置便利；如要更严，可只授前四项 + 一次性授权 CREATE/INDEX 用于首启建表
FLUSH PRIVILEGES;
```

连接串里的特殊字符注意：password 会经 `encodeURIComponent` 编码后拼入连接串，`@ : / #` 等字符可安全使用；**database 名不做编码**，请使用常规标识符（字母/数字/下划线）。

### 2.3 连通性预检（应用机上执行）

```bash
mysql -h <db-host> -P 3306 -u ddw -p ddw -e "SELECT VERSION();"
```

### 2.4 DBA 须知（两处约定，均不影响应用）

- **JSON 列双重编码**：`ddw_tasks.pkg`/`result`、`ddw_events.payload`、各 `doc` 列内的字符串值外
  多一层引号转义（审计 hash 链 canonical 键序所需）。用 SQL 直接读时看到的是
  `"{\"taskId\":...}"` 形态，属预期，**不要在 DB 侧"修数据"**。
- **`ddw_messages` 滚动保留 1000 条**：插入时应用自动删除超额旧消息，无需归档作业。
- 事件表 `ddw_events` 增长最快（含 payload），容量规划按任务量评估；审计数据**只增不删**。

## 3. 离线交付包制作（有网开发机）

```bash
git checkout <交付 tag/commit>
node scripts/offline-pack.mjs        # 产出 dist-offline/ddw-offline-<date>.tar.gz
node scripts/rehearsal.mjs           # 一键预演：打包→解包模拟试点机→离线安装→冒烟→巡检
```

- 包内容：`repo/`（源码）+ `pnpm-store/`（依赖仓库，**含 mysql2**——它已入 lockfile，离线包自动携带）+
  `install.sh` + `OFFLINE.md`。
- 离线冒烟 `pnpm -r test` 在无 `DDW_TEST_MYSQL_URL` 环境变量时，MySQL 分支用例**自动整组 skip**
  （47 例），其余全绿即为安装成功——内网机上不需要（也不应）真连 MySQL 跑测试。
- 拷贝介质带入内网（tar 包约数百 MB）。

## 4. 内网安装

```bash
sudo mkdir -p /opt/ddw && sudo chown ddw:ddw /opt/ddw
sudo -iu ddw
tar -xzf ddw-offline-<date>.tar.gz -C /opt/ddw && cd /opt/ddw/repo   # 按包内结构
bash install.sh
```

install.sh 依次：Node 版本前置检查（< 20.5 首错即拦）→ `pnpm install --offline --frozen-lockfile
--store-dir ./pnpm-store`（全程不出网）→ `pnpm -r test` 冒烟。失败按脚本内提示排查（store 完整性 /
`df -h` / `node -v`）。

## 5. 凭据与运行时配置（密文落盘，主密钥不落盘）

### 5.1 生成主密钥（一次性）

```bash
cd /opt/ddw/repo
export DDW_CRED_KEY=$(node packages/console-api/src/cli.ts cred key)
# 持久化（systemd 经 EnvironmentFile 注入）：
sudo mkdir -p /etc/ddw && echo "DDW_CRED_KEY=$DDW_CRED_KEY" | sudo tee /etc/ddw/env
sudo chmod 600 /etc/ddw/env && sudo chown ddw:ddw /etc/ddw/env
```

> **主密钥务必另行抄录到密码保管系统**——`/etc/ddw/env` 丢失后所有密文（apiKey / MySQL password）
> 全部无法解密，只能重新 enc。

### 5.2 加密各凭据

```bash
export DDW_CRED_KEY=$(grep -oP '(?<=DDW_CRED_KEY=).*' /etc/ddw/env)
node packages/console-api/src/cli.ts cred enc '<模型集群真实apiKey>'    # → routes 的 apiKey
node packages/console-api/src/cli.ts cred enc '<MySQL ddw 账户口令>'    # → storage.mysql.password
node packages/console-api/src/cli.ts cred enc '<GitLab/Gitea PAT>'      # → forge.token
```

### 5.3 生产 runtime yaml（完整示例，逐字段注释）

存为 `/etc/ddw/runtime.yaml`（`chmod 600`，owner ddw）。**员工名册机制**：yaml `profiles` 仅在
员工库为空时作为**首启种子**导入（`seedFrom`，单值岗位）；之后一切员工维护（多岗位、一人一模型
一 key、盯梢等级、停用）都在管理台「数字员工」页操作，改 yaml 不再影响已入库员工。

```yaml
# ===== 数字员工名册（首启种子；库已有员工时整段忽略）=====
profiles:
  - id: emp-01
    name: 小数
    role: 后端开发            # 必须与 Skill 分类（岗位）名严格一致
    skills: [后端开发]        # 兼容保留，不参与分派（调度按岗位精确匹配）
    supervision:
      level: shadow          # shadow 盯梢期 / assisted 辅助 / trusted 信任
      extraCommands: []      # trusted 级放行的额外 bash 命令（首 token）

workspaceRoot: /opt/ddw/data/workspace   # 员工工作区根（per-employee/task 隔离，文件）
sessionsRoot: /opt/ddw/data/sessions     # 会话 jsonl 根（per-employee 隔离，文件）

# ===== 模型路由（四类调用分路；双协议 openai-completions | anthropic-messages）=====
routes:
  - callType: chat
    primary: { name: 主力对话模型, baseUrl: http://<模型集群>/v1, apiKey: "enc:v1:…", model: <模型名> }
  - callType: code
    primary: { name: 代码模型, baseUrl: http://<模型集群>/v1, apiKey: "enc:v1:…", model: <模型名> }
    fallback: { name: 备用代码模型, baseUrl: http://<模型集群>/v1, apiKey: "enc:v1:…", model: <备用模型名> }
  - callType: review
    primary: { name: 评审模型, baseUrl: http://<模型集群>/v1, apiKey: "enc:v1:…", model: <模型名> }
  - callType: test
    primary: { name: 测试模型, baseUrl: http://<模型集群>/v1, apiKey: "enc:v1:…", model: <模型名> }

# ===== MySQL 存储（本手册核心段）=====
storage:
  driver: mysql                  # sqlite | mysql
  mysql:
    host: 10.x.x.x               # 必填
    port: 3306                   # 可省，缺省 3306
    user: ddw                    # 必填
    password: "enc:v1:…"         # 必填位；明文/enc 密文两用，生产务必密文
    database: ddw                # 必填（§2.1 建的库）

# ===== 代码托管协作（配了员工才获得建分支/提交/MR 工具）=====
forge:
  provider: gitlab               # gitlab | gitea（内网 GitLab 填 gitlab）
  baseUrl: http://<内网GitLab>
  token: "enc:v1:…"

# ===== 任务执行模式与调度 =====
execMode: fork                   # fork=每任务独立子进程（崩溃隔离，生产推荐）；inproc=单进程
tickIntervalMs: 5000

# ===== 发布部署（产物复制 + 重启；按需配）=====
deploy:
  envs:
    - name: test
      artifactDir: /opt/ddw/web-app
      restartCommand: "bash /opt/ddw/restart.sh"
      artifactPath: dist

bashWhitelist: [git, node, npm, npx, python3]
```

**其余两点**：

- 通知渠道（钉钉加签/企微/Webhook/内部燕讯）不在 yaml——管理台「通知渠道」页后台增删（落 MySQL `ddw_channels`）；
  推送内容默认不含任务直达链接（`consoleUrl` 当前仅程序化装配支持，yaml 不读取）。
  燕讯类型渠道在页面只配机器人 access_token，端点与报文头固定参数走 yaml `yanxun:` 段
  （`apiUrl` + `requestHead`，tranDate/tranTime/consumerSeqNo 发送时自动生成，`isAtAll` 全局默认 '0'）；
  yaml 未配 `yanxun:` 段时燕讯渠道推送/测试报「需在 runtime yaml 配置 yanxun 段」。
- 标准 MCP server 可经 `mcpServers:` 段注册（yaml 注册即接入，管理台能力管理自动展示）。

**storage 段校验规则**（启动即校验，报错为中文可读信息）：

- `driver` 必须是 `sqlite`/`mysql` 之一；
- `driver: mysql` 时 `host`/`user`/`database` 缺一即启动失败；
- `driver: mysql` 却配了 `sqlite` 段（或反之）= 配置矛盾，启动失败——**不会静默忽略**；
- 缺省（无 storage 段）= sqlite + `<dataDir>/ddw.sqlite`（本手册不使用）；
- 旧 `--store` CLI 参数已退役，传入即报错退出。

## 6. 存量数据迁移（仅"从 sqlite 旧版升级"场景；全新部署跳过本节）

适用：试点机已用旧版本（P17 之前）跑过任务，数据落在旧 sqlite + 5 个 JSON 档案中。

```bash
cd /opt/ddw/repo
export DDW_CRED_KEY=$(cat /etc/ddw/env | cut -d= -f2)   # mysql password 密文解密需要
node packages/console-api/src/cli.ts migrate \
  --to mysql \
  --data /opt/ddw/old-data \        # 旧数据目录（旧 ddw.sqlite 与 5 个 JSON 所在）
  --runtime /etc/ddw/runtime.yaml   # 目标 MySQL 从该 yaml 的 storage 段读取
```

**行为约定**：

- 8 个域一次性导入：任务 / 事件 / 员工 / Skill 分类 / Skill / 能力 / 消息 / 通知渠道；输出逐域计数对账；
- **目标库非空即拒绝执行**（防误覆盖）；同 id 重复行自动跳过并计入 skippedRows 提示；
- 成功后在旧数据目录写 `migrated-mysql.marker` 留痕；**旧源文件一律不动**，确认业务正常后自行归档；
- 重复执行安全（有 marker / 目标已有数据会被拦）。

> 全新部署（空库）**不要**跑 migrate——直接启动，首次自动建表 + 种子（五类岗位分类/四类能力预设）。

## 7. 巡检（启动前体检，不监听端口）

```bash
cd /opt/ddw/repo
export DDW_CRED_KEY=$(cat /etc/ddw/env | cut -d= -f2)
node packages/console-api/src/cli.ts doctor --data /opt/ddw/data \
  --runtime /etc/ddw/runtime.yaml --probe
```

检查项与 MySQL 版期望：

| 检查项 | MySQL 版期望 |
|---|---|
| Node 版本 | ✓ ≥ 20.5 |
| 数据目录可写 | ✓（workspace/sessions/快照仍落这里） |
| **存储连通** | ✓ MySQL 可连、`ddw` 库可达；未建表时提示「首次启动自动建表」不阻塞 |
| 存储与审计 hash 链 | ✓ 空库/旧表链校验通过 |
| 运行时配置与凭据 | ✓ yaml 解析 + 全部 enc:v1: 解密成功 |
| 主密钥 | ✓ 64 位 hex |
| bash 白名单命令 | ✓ 全部在 PATH |
| 模型集群连通（--probe） | ✓ 任意 HTTP 响应即算内网可达 |

任一 ✗ → 按 §11 排查表处置；全 ✓ 再启动。**注意：doctor 与服务进程都必须持有 `DDW_CRED_KEY`**，
否则 storage 密文口令 / apiKey 解不开，巡检/启动直接红。

## 8. 启动（systemd 常驻）+ 管理台前端

### 8.1 后端服务

复制 `scripts/ddw-console.service` 到 `/etc/systemd/system/`，MySQL 版需确认三处：

```ini
[Service]
User=ddw
Group=ddw
WorkingDirectory=/opt/ddw/repo
EnvironmentFile=/etc/ddw/env                      # 注入 DDW_CRED_KEY
ExecStart=/usr/bin/node packages/console-api/src/cli.ts \
  --port 3100 \
  --data /opt/ddw/data \
  --runtime /etc/ddw/runtime.yaml                 # ← 指向生产 yaml（storage: mysql 在这里生效）
Restart=on-failure
RestartSec=5
ReadWritePaths=/opt/ddw/data                      # workspace/sessions/快照仍需文件写权限
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ddw-console
sudo systemctl status ddw-console
journalctl -u ddw-console -f        # 应看到：storage: mysql + 一体化模式名册日志
```

启动失败即退出（exit 1）的硬校验：yaml 解析、密文解密、**MySQL 连接 / 建表失败**——都不会带病运行。

### 8.2 管理台前端（构建产物 + nginx）

```bash
cd /opt/ddw/repo/apps/console
npx vite build                      # 产物 dist/（离线包内已完成依赖安装）
```

nginx 站点示例：

```nginx
server {
  listen 80;
  root /opt/ddw/repo/apps/console/dist;
  location /api/ { proxy_pass http://127.0.0.1:3100; }   # 关键：/api 反代后端
}
```

试点/临时演示也可 `npx vite --port 5173`（内置 `/api → 3100` 代理），正式交付一律静态产物。

## 9. 冒烟验收清单（交付签字依据）

| # | 验收项 | 操作 | 通过标准 |
|---|---|---|---|
| 1 | 安装冒烟 | install.sh | pnpm -r test 全绿（mysql 用例 skip 属预期） |
| 2 | 巡检 | doctor --probe | 全部 ✓ 含「存储连通」，退出码 0 |
| 3 | 服务常驻 | systemctl status | active (running)；`journalctl` 见 `storage: mysql` |
| 4 | 建表核验 | `mysql -u ddw -p ddw -e 'SHOW TABLES'` | 8 张 `ddw_*` 表齐全 |
| 5 | 控制台可达 | 浏览器开前端地址 | 首页面板/名册/Skill 库可打开 |
| 6 | **数据真落 MySQL** | 管理台新建 1 条草稿任务 | `SELECT COUNT(*) FROM ddw_tasks` 增长；`data/` 下无新 JSON 数据文件 |
| 7 | 任务链路 | 发布任务包 → 数字员工接单执行 | 直播时间线有思考/工具事件；任务 done；事件落 `ddw_events` |
| 8 | 盯梢闭环 | shadow 级员工申报节点 | 待审可见 → 放行继续 / 驳回按意见重报 |
| 9 | 审计完整 | `curl 'http://127.0.0.1:3100/api/audit?integrity=1'` | `ok: true`（hash 链成链） |
| 10 | 服务重启数据完好 | systemctl restart ddw-console | 任务/名册/Skill 库原样（数据在 MySQL 不在进程内存） |

## 10. 日常运维

### 10.1 备份（两部分缺一不可）

```bash
# ① 业务数据（每日）：
mysqldump -h <db-host> -u ddw -p --single-transaction --routines=false ddw \
  > /backup/ddw-$(date +%F).sql
# ② 文件部分（每日）：
tar -czf /backup/ddw-files-$(date +%F).tgz /opt/ddw/data /etc/ddw
#   data 下：workspace/ sessions/ audit-heads.jsonl（审计链头快照，篡改存证）
#   /etc/ddw：runtime.yaml + env（密文可重建，主密钥丢失即全部作废）
```

**升级/重装前**同样先做这两份备份。

### 10.2 升级流程

1. 停服务 `systemctl stop ddw-console` → 2. 备份（§10.1）→ 3. 换新包重跑 `install.sh` →
4. `doctor` 全绿 → 5. 起服务 → 6. §9 验收 4/6/9 复核。

MySQL 表结构由新版首启自动幂等迁移（`CREATE TABLE IF NOT EXISTS` 语义）；跨大版本如需数据迁移以发布说明为准。

### 10.3 回滚

停服务 → 换回旧版包 → `mysql ddw < /backup/ddw-<日期>.sql` 还原库 → 还原文件备份 → 起服务。
审计链数据向前兼容，回滚不破坏链。

### 10.4 监控建议

- `systemctl is-active ddw-console`（存活）+ journalctl 错误关键字 `schema 初始化失败`/`[store]`/`死锁`;
- MySQL 侧：`ddw_events` 行数增速（审计量）、连接数（应用池上限 10）、慢查询;
- 业务侧：`GET /api/messages` 徽标 / 通知渠道推送是否到达。

## 11. 故障排查表

| 症状 | 可能原因 | 处置 |
|---|---|---|
| 启动即退：`storage.mysql.host 必须是非空字符串` 等 | storage 段字段缺失/类型错 | 按报错补 §5.3 yaml；注意 driver 与段交叉矛盾也会拦 |
| 启动即退：连接失败 `ECONNREFUSED` / `ER_ACCESS_DENIED_ERROR`(1045) | 网络不通 / 账号口令错 / host 白名单不符 | §2.3 预检；`'ddw'@'10.%'` host 范围与应用机 IP 匹配 |
| 启动即退：`Unknown database 'ddw'`(1049) | 库未建 | §2.1 建库（表会自动建，库不会） |
| 启动即退：密文解密失败 | DDW_CRED_KEY 未注入/换过 key | `EnvironmentFile=/etc/ddw/env` 生效？换 key 后所有密文须重新 `cred enc` |
| doctor「存储连通」✗ 但 mysql 命令行可连 | yaml 字段错 / dns vs ip | 核对 host/port；应用机与操作机网络路径可能不同 |
| 运行中偶发 `ER_LOCK_DEADLOCK` 日志但业务正常 | 审计链高并发分叉，应用内已自动重试 | 正常现象；若频繁出现检查是否多实例共用同一库 |
| 事件/审计校验 `integrity=1` 报断链 | 库被手工改过 / DBA 侧"修正"过 JSON 双重编码 | **不要删数据**：先备份，导出 brokenAt 断点排查；§2.4 双重编码是预期不是损坏 |
| 任务状态卡 claimed 但无进程 | 上次 kill -9 / 宕机 | 管理台重跑该任务（终态/停滞任务可重提交，会清残留窄列） |
| 消息条数不涨反减 | `ddw_messages` 滚动保留 1000 条 | 预期行为（§2.4） |
| install.sh 冒烟失败 | store 不完整/磁盘满/Node 低 | 按脚本提示；确认 pnpm-store 目录完整拷贝 |
| 前端可开但接口全 404 | nginx 未反代 /api | §8.2 `location /api/` |

## 12. 安全要点（企业内评审关注项）

- **凭据三不落盘明文**：模型 apiKey、MySQL password、托管 token 全部 `enc:v1:` 密文存 yaml；
  主密钥只在 `/etc/ddw/env`（600）+ 密码保管系统，不进 git/备份网盘。
- **MySQL 最小授权**：专用账号仅 `ddw.*` 库内 DML+建表；不给全局权限；host 按网段收紧。
- 审计 hash 链 + 库外链头快照（`audit-heads.jsonl`）：改库必暴露；快照文件纳入备份但不给业务方写权限。
- 出方向仅四类端点（模型/Git 托管/Jira/DevOps），无任何公网访问；UI 垫片仅限无 API 钉子户系统。
- systemd 硬化（ProtectSystem=strict / NoNewPrivileges）+ 专用 ddw 用户。

## 13. 硬排除项（不做/不支持）

- 验证码 / SSO / UKey 系统的 UI 垫片；对公网的一切访问；自动安装 systemd 单元（样例须运维评审）。
- 多实例分库分片、MySQL 主从/集群语义（单实例 DSN；多 console-api 实例可共享同一库，claim 原子抢单安全）。
