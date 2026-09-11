# 数字员工 Skill 管理模块设计（2026-09-06）

## 背景与目标

数字员工共用一个 **Skill 库**：入库 skill 需经严格（人工终审）审查；员工每完成一个任务后**自动沉淀**项目知识/技能知识，汇聚为 skill 或开发约束进入待审查队列；新建/编辑员工时按**技能分类**关联 skill，执行任务时自动注入。

**方案选型**：方案 A——文件库 + 执行链注入 + 异步蒸馏沉淀（与 capabilities/employees 的 JSON 文件 store 模式同构，无新依赖）。Gitea 仓库存 skill（方案 B）与 sqlite 版本化（方案 C）被否决。

## 一、数据模型（`packages/console-api/src/team/skill-store.ts` 新建）

```ts
/** Skill 类型：knowledge 知识文档 / constraint 开发约束 / asset 可执行资产（附带脚本模板） */
type SkillType = 'knowledge' | 'constraint' | 'asset';

interface SkillRecord {
  id: string;                 // skill-<uuid8>
  categoryId: string;         // 所属技能分类 id
  name: string;
  description: string;
  type: SkillType;
  content: string;            // markdown 正文（knowledge/constraint 即生效内容；asset 为使用说明）
  assetFiles?: { path: string; content: string }[];  // 仅 asset：相对 .skills/<skillId>/ 的文件
  status: 'pending' | 'approved' | 'rejected';
  source: 'manual' | string;  // 自动沉淀时为 auto:<taskId>
  sourceTaskId?: string;      // 沉淀来源任务（审查时回看任务上下文）
  createdAt: number;
  reviewedAt?: number;
}

interface SkillCategory { id: string; name: string; description?: string; }
```

**存储**：`FileSkillStore`，单文件 `<dataDir>/skills.json`，mutate 队列串行化 + tmp 文件原子 rename——与 `FileEmployeeStore` 同构（缓存、仅 ENOENT 视为不存在、损坏原样上抛）。

**分类**：内置 seed 五类（后端开发 / 前端开发 / 测试 / DevOps / 安全合规），管理台可增删改；删除分类时若仍有 skill 挂载则 409 拒绝。

**校验（upsert 前统一执行，错误可读、HTTP 层 400）**：
- `type` 枚举；`categoryId` 必须存在于分类表
- `asset` 类型必须带非空 `assetFiles`；`path` 禁 `..`、禁绝对路径、禁空 path（防路径逃逸）
- `name`/`content` 非空；`status` 仅审查接口可变（普通 upsert 保留原 status）

## 二、API（挂到现有 handlers）

| 方法与路径 | 语义 |
|---|---|
| `GET/POST/PUT/DELETE /api/skill-categories` | 分类 CRUD（DELETE 有挂载 409） |
| `GET /api/skills?status=&categoryId=&q=` | 列表（可按状态/分类/关键词过滤） |
| `POST /api/skills` | 新建（即 pending；管理台手工录入也走审查） |
| `PUT /api/skills/:id` | 编辑（status 不变） |
| `DELETE /api/skills/:id` | 删除 |
| `POST /api/skills/:id/review` | `{ action: 'approve' \| 'reject' }` 终审；允许改判（重审幂等） |

## 三、员工关联

- `EmployeeRecord` 新增 `skillCategories: string[]`（可空 = 不挂任何 skill）；**现有 `skills`（岗位标签）语义不动**，调度 role 匹配不受影响
- `validateEmployeeRecord` 校验：分类 id 必须存在于分类表（分类表为空时不设限）
- 前端 `EmployeeEditDialog.vue` 加「技能分类」多选（数据源 `/api/skill-categories`）

## 四、执行链注入（plan-runner）

每项执行前按员工 `skillCategories` 取 **approved** 的 skill：

- `knowledge` / `constraint`：以「## 技能与约束（来自 Skill 库）」追加到任务指令尾部；每条截 2000 字符、总量截 8000 字符（防 token 爆炸）
- `asset`：workspace 准备阶段把 `assetFiles` 落到 `workspace/.skills/<skillId>/`；指令附「可用资产清单」（路径 + 用途），员工用现有受控 bash（git/node/npm/npx/python3 白名单）调用
- **fork 模式**：沿用 capabilities 快照先例——分派时取 skill 快照（按员工分类过滤后的 approved 清单）随 job 下发，worker 内注入逻辑与 inproc 一致

## 五、自动沉淀（distiller）

- **触发点**：调度器 `finish` 且任务全部计划项 done 后**异步**触发（不阻塞状态落库；失败只留事件留痕）
- **输入**：任务包 + 执行事件留痕 + 工作区 `git diff`（摘要模式）
- **产出**：模型输出**候选 skill JSON**（从现有分类中选 categoryId、定 type、写 content，可附 assetFiles）→ 以 `status: pending, source: auto:<taskId>` 入库 + 复用消息中心推「Skill 待审查」消息
- **限额**：每任务最多产出 2 条候选（防刷库）
- **失败处理**：模型不可用 / JSON 解析失败 / 分类不存在 → 事件留痕后跳过，不影响任务终态

## 六、前端

- 新页面 `SkillLibrary.vue`（路由 `/skills` + 侧边栏「Skill 库」入口）：
  - 上方检索区：关键词 + 分类下拉 + 状态下拉（待审查数量徽标）
  - 下方表格：类型/分类/状态列，行内「批准/驳回」（仅 pending）、「编辑」「删除」
  - 新建/编辑对话框：分类下拉、类型下拉、markdown 正文 textarea、asset 类追加文件行编辑（path + content）
  - 「管理分类」对话框：增删改（挂载保护提示）
- `EmployeeEditDialog.vue`：「技能分类」多选
- `EmployeeDetail.vue`：展示已挂分类与生效 skill 数

## 七、错误处理汇总

| 场景 | 处理 |
|---|---|
| distiller 模型失败 / 解析失败 | 事件留痕，跳过，不影响任务终态 |
| assetFiles 路径逃逸 | 校验拒绝（400） |
| 分类删除仍有挂载 | 409 拒绝 |
| 审查改判 | 允许（approved ↔ rejected 重审幂等） |
| 消息推送失败 | 只记日志（复用消息中心旁路语义） |

## 八、测试

- `skill-store.test.ts`：CRUD、校验（type/categoryId/path 逃逸）、原子写、分类删除保护
- `handlers.test.ts`：路由 + 审查动作 + 400 文案
- `distiller.test.ts`：模型替身产出候选入库、解析失败留痕、每任务上限 2 条
- plan-runner 注入测试：指令追加正确、截断生效、非 approved 不注入、fork 快照一致
- 前端：`skill-library.test.ts`（渲染/过滤/审查流）、`employee-edit-dialog` 分类多选

## 明确不做（YAGNI）

- Skill 版本历史 / diff 对比（后续可加）
- AI 预审（当前纯人工终审）
- 员工关联具体条目（当前按分类；条目微调二期）
- asset 执行沙箱（复用受控 bash 白名单，不新增沙箱）
