import { describe, it, expect } from 'vitest';
import { parseTaskPackage } from '../src/task/package.js';

const validYaml = `
taskId: TASK-2026-0912-001
title: 登录模块前端重构
repo:
  url: http://gitlab.inner.bank/frontend/web-app.git
  branch: feature/login-refactor
  baseBranch: develop
tasks:
  - id: T-1
    title: 登录页组件拆分
    files:
      - src/views/login/index.vue
      - src/views/login/components/LoginForm.vue
    requirement: 将登录页拆分为表单子组件，逻辑保持不变
    acceptance:
      - npm run build 通过
      - 现有登录 e2e 用例全绿
  - id: T-2
    title: 登录接口联调
    files:
      - src/api/auth.ts
    requirement: 按 apiDocs 对接新登录接口
    acceptance:
      - 联调用例通过
apiDocs: http://gitlab.inner.bank/api-docs/auth.md
codingStandard: 遵循仓库 ESLint 配置与团队 Vue 规范
`;

describe('parseTaskPackage', () => {
  it('合法 yaml 解析出完整 TaskPackage', () => {
    const pkg = parseTaskPackage(validYaml);
    expect(pkg.taskId).toBe('TASK-2026-0912-001');
    expect(pkg.repo.branch).toBe('feature/login-refactor');
    expect(pkg.repo.baseBranch).toBe('develop');
    expect(pkg.tasks).toHaveLength(2);
    expect(pkg.tasks[0].files).toContain('src/views/login/index.vue');
    expect(pkg.tasks[1].acceptance).toEqual(['联调用例通过']);
    expect(pkg.apiDocs).toContain('api-docs/auth.md');
    expect(pkg.codingStandard).toContain('Vue 规范');
  });

  it('缺 repo.branch 抛错并指明字段路径', () => {
    const broken = validYaml.replace('  branch: feature/login-refactor\n', '');
    expect(() => parseTaskPackage(broken)).toThrow('repo.branch');
  });

  it('缺 taskId 抛错', () => {
    const broken = validYaml.replace('taskId: TASK-2026-0912-001\n', '');
    expect(() => parseTaskPackage(broken)).toThrow('taskId');
  });

  it('tasks 为空数组抛错', () => {
    const broken = validYaml.replace(/tasks:[\s\S]*?apiDocs/, 'tasks: []\napiDocs');
    expect(() => parseTaskPackage(broken)).toThrow('tasks');
  });

  it('dev task 缺 files 抛错并指明任务 id', () => {
    const broken = validYaml.replace(
      '    files:\n      - src/api/auth.ts\n',
      '',
    );
    expect(() => parseTaskPackage(broken)).toThrow('T-2');
  });

  it('非法 yaml 抛错', () => {
    expect(() => parseTaskPackage('a: [unclosed')).toThrow();
  });

  // —— 二期班组编排字段（P8，spec 4.2 包级依赖）——

  it('role + dependsOn 解析为可选字段', () => {
    const pkg = parseTaskPackage(validYaml.replace(
      'title: 登录模块前端重构',
      'title: 登录模块前端重构\nrole: frontend\ndependsOn:\n  - TASK-2026-0912-000\n  - TASK-2026-0912-002',
    ));
    expect(pkg.role).toBe('frontend');
    expect(pkg.dependsOn).toEqual(['TASK-2026-0912-000', 'TASK-2026-0912-002']);
  });

  it('不写 role/dependsOn 照常解析（向后兼容）', () => {
    const pkg = parseTaskPackage(validYaml);
    expect(pkg.role).toBeUndefined();
    expect(pkg.dependsOn).toBeUndefined();
  });

  it('dependsOn 非数组抛错', () => {
    const broken = validYaml.replace('title: 登录模块前端重构', 'title: 登录模块前端重构\ndependsOn: TASK-X');
    expect(() => parseTaskPackage(broken)).toThrow('dependsOn');
  });

  it('dependsOn 空数组抛错（无依赖应省略字段）', () => {
    const broken = validYaml.replace('title: 登录模块前端重构', 'title: 登录模块前端重构\ndependsOn: []');
    expect(() => parseTaskPackage(broken)).toThrow('dependsOn');
  });

  it('dependsOn 含非字符串元素抛错', () => {
    const broken = validYaml.replace('title: 登录模块前端重构', 'title: 登录模块前端重构\ndependsOn:\n  - TASK-X\n  - 123');
    expect(() => parseTaskPackage(broken)).toThrow('dependsOn');
  });

  it('role 非字符串抛错', () => {
    const broken = validYaml.replace('title: 登录模块前端重构', 'title: 登录模块前端重构\nrole: [frontend]');
    expect(() => parseTaskPackage(broken)).toThrow('role');
  });

  // —— 指定员工分派（assignee，2026-09-06，可选）——

  it('assignee 合法字符串透传', () => {
    const pkg = parseTaskPackage(validYaml.replace(
      'title: 登录模块前端重构',
      'title: 登录模块前端重构\nassignee: emp-01',
    ));
    expect(pkg.assignee).toBe('emp-01');
  });

  it('assignee 缺省不出键（向后兼容）', () => {
    const pkg = parseTaskPackage(validYaml);
    expect(pkg.assignee).toBeUndefined();
    expect('assignee' in pkg).toBe(false);
  });

  it('assignee 空串视为未指定', () => {
    const pkg = parseTaskPackage(validYaml.replace(
      'title: 登录模块前端重构',
      'title: 登录模块前端重构\nassignee: ""',
    ));
    expect(pkg.assignee).toBeUndefined();
  });

  it('assignee 非字符串抛错且报错可读', () => {
    const broken = validYaml.replace('title: 登录模块前端重构', 'title: 登录模块前端重构\nassignee: 42');
    expect(() => parseTaskPackage(broken)).toThrow('assignee 应为字符串（员工 id）');
  });
});

describe('plan 字段（任务计划，2026-09-05）', () => {
  const planYaml = `
taskId: feat-login
title: 登录功能开发
repo: { url: "http://localhost:3000/demo/web-app.git", branch: develop }
plan:
  - id: t1
    title: 开发登录接口
    detail: 实现 POST /api/login
  - id: t2
    kind: commit
    title: 提交并建 MR
    detail: 提交 feature 分支并建 MR
    verify: npm run build
role: backend
`;
  it('plan 解析：kind 缺省 dev，verify/kind 透传', () => {
    const pkg = parseTaskPackage(planYaml);
    expect(pkg.plan).toHaveLength(2);
    expect(pkg.plan![0]!.kind).toBeUndefined();      // 解析层不填缺省值，运行层查注册表时落 dev
    expect(pkg.plan![1]!.kind).toBe('commit');
    expect(pkg.plan![1]!.verify).toBe('npm run build');
  });

  it('plan 与 tasks 互斥：同时存在报错可读', () => {
    const both = planYaml + 'tasks:\n  - id: d1\n    title: x\n    files: [a]\n    requirement: r\n    acceptance: [a1]\n';
    expect(() => parseTaskPackage(both)).toThrow(/plan 与 tasks 互斥/);
  });

  it('plan 项缺 id/title/detail 报错可读；id 重复报错可读', () => {
    const miss = planYaml.replace('    detail: 实现 POST /api/login\n', '');
    expect(() => parseTaskPackage(miss)).toThrow(/plan\[t1\]\.detail/);
    const dup = planYaml.replace('  - id: t2', '  - id: t1');
    expect(() => parseTaskPackage(dup)).toThrow(/plan 项 id 重复: t1/);
  });

  it('无 plan 的老任务包解析零回归（tasks 照旧必填）', () => {
    const old = `
taskId: t
title: x
repo: { url: "http://x/a.git", branch: main }
tasks:
  - id: d1
    title: x
    files: [a]
    requirement: r
    acceptance: [a1]
`;
    expect(parseTaskPackage(old).plan).toBeUndefined();
    expect(() => parseTaskPackage(old.replace(/tasks:[\s\S]*/, ''))).toThrow(/tasks/);
  });
});
