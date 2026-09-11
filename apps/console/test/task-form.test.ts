import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { nextPlanId, pkgToYaml, planFormToYaml, yamlToPlanForm } from '../src/task-form.js';
import type { TaskPackage } from '@ddw/runtime';

describe('task-form（任务创建双模式，2026-09-05）', () => {
  const form = {
    taskId: 'feat-login', title: '登录功能开发', role: 'backend',
    repoUrl: 'http://localhost:3000/demo/web-app.git', branch: 'develop',
    plan: [
      { id: 't1', kind: '', title: '开发登录接口', detail: '实现 POST /api/login', verify: '' },
      { id: 't2', kind: 'commit', title: '提交并建 MR', detail: '提交 feature 分支并建 MR', verify: 'npm run build' },
    ],
  };

  it('planFormToYaml：空 kind/verify 字段不输出；生成 yaml 可被后端解析（含 plan）', () => {
    const yaml = planFormToYaml(form);
    expect(yaml).toContain('plan:');
    expect(yaml).toContain('kind: commit');
    // 空缺省不写（除 commit 那行外无其他 kind:）——注：'not.toContain(kind:)' 与上一行矛盾，用计数断言表达同一意图
    expect(yaml.split('kind:').length - 1).toBe(1);
    expect(yaml).not.toContain("verify: ''");
  });

  it('yamlToPlanForm：yaml（含 plan）反填表单；不含 plan 的 yaml → plan: []（老包走 yaml 模式展示）', () => {
    const back = yamlToPlanForm(planFormToYaml(form));
    expect(back.taskId).toBe('feat-login');
    expect(back.plan).toHaveLength(2);
    expect(back.plan[1]!.kind).toBe('commit');
    expect(back.plan[0]!.kind).toBe('');
    expect(yamlToPlanForm('taskId: t\ntitle: x\nrepo: { url: "http://x/a.git", branch: main }\ntasks: []\n').plan).toEqual([]);
  });

  it('yamlToPlanForm：老包字段（tasks 等）非空时记入 legacyFields；纯 plan yaml 的 legacyFields 为空', () => {
    // 老式 tasks 包：tasks 字段在场且非空
    const legacy = yamlToPlanForm(
      'taskId: t\ntitle: x\nrepo: { url: "http://x/a.git", branch: main }\ntasks:\n  - taskId: s1\n',
    );
    expect(legacy.legacyFields).toContain('tasks');
    // baseBranch（按后端 schema 嵌在 repo 下）仍记入；dependsOn 已转正（表单支持），不再记 legacy
    const mixed = yamlToPlanForm(
      'taskId: t\ntitle: x\nrepo: { url: "http://x/a.git", branch: main, baseBranch: develop }\ndependsOn: [t0]\n',
    );
    expect(mixed.legacyFields).toContain('baseBranch');
    expect(mixed.legacyFields ?? []).not.toContain('dependsOn');
    // 空值不算（tasks: [] 空列表、apiDocs 空标量均无内容可丢）
    const emptyValues = yamlToPlanForm(
      'taskId: t\ntitle: x\nrepo: { url: "http://x/a.git", branch: main }\ntasks: []\napiDocs:\n',
    );
    expect(emptyValues.legacyFields ?? []).toEqual([]);
    // 纯 plan yaml：无老包字段
    const pure = yamlToPlanForm(planFormToYaml(form));
    expect(pure.legacyFields ?? []).toEqual([]);
  });

  it('dependsOn：表单序列化输出顶层 dependsOn，空数组不输出；反填解析并不再记 legacy', () => {
    const yaml = planFormToYaml({
      taskId: 'T1', title: 'x', role: 'backend', repoUrl: 'u', branch: 'b',
      dependsOn: ['T0'],
      plan: [{ id: 't1', kind: '', title: 'p', detail: '', verify: '' }],
    });
    expect(yaml).toContain('dependsOn:\n  - T0');
    const back = yamlToPlanForm(yaml);
    expect(back.dependsOn).toEqual(['T0']);
    expect(back.legacyFields ?? []).not.toContain('dependsOn');
    // 空数组不输出（表单未选依赖时 yaml 不出现 dependsOn 键）
    const noDeps = planFormToYaml({
      taskId: 'T1', title: 'x', role: '', repoUrl: 'u', branch: 'b',
      dependsOn: [],
      plan: [{ id: 't1', kind: '', title: 'p', detail: '', verify: '' }],
    });
    expect(noDeps).not.toContain('dependsOn');
  });

  it('assignee：非空出顶层键并反填还原；空/缺省不出键（2026-09-06 指定员工）', () => {
    const yaml = planFormToYaml({
      taskId: 'T1', title: 'x', role: 'backend', repoUrl: 'u', branch: 'b',
      assignee: 'emp-01',
      plan: [{ id: 't1', kind: '', title: 'p', detail: '', verify: '' }],
    });
    expect(yaml).toContain('assignee: emp-01');
    expect(yamlToPlanForm(yaml).assignee).toBe('emp-01');
    // 空串不出键；纯空格视为空
    const blank = planFormToYaml({
      taskId: 'T1', title: 'x', role: '', repoUrl: 'u', branch: 'b',
      assignee: '  ',
      plan: [{ id: 't1', kind: '', title: 'p', detail: '', verify: '' }],
    });
    expect(blank).not.toContain('assignee');
    // 缺省（既有 fixture 无 assignee）同样不出键
    expect(planFormToYaml(form)).not.toContain('assignee');
    // yaml 里有 assignee 时反填还原；assignee 不是老包字段（不记 legacy）
    const back = yamlToPlanForm(
      'taskId: t\ntitle: x\nrepo: { url: "http://x/a.git", branch: main }\nassignee: emp-02\n',
    );
    expect(back.assignee).toBe('emp-02');
    expect(back.legacyFields ?? []).not.toContain('assignee');
  });

  it('nextPlanId：空列表 t1 起步；删除中间行后再添加不与既有 id 冲突', () => {
    expect(nextPlanId([])).toBe('t1');
    expect(nextPlanId(['t1'])).toBe('t2');
    expect(nextPlanId(['t1', 't2'])).toBe('t3');
    // 删掉 t2 后剩 t1/t3 → 取最大序号+1
    expect(nextPlanId(['t1', 't3'])).toBe('t4');
    expect(nextPlanId(['t10'])).toBe('t11');
    // 无数字 id 按行数计数兜底
    expect(nextPlanId(['dev-a', 'dev-b'])).toBe('t3');
  });

  it('pkgToYaml（编辑回填，2026-09-06 draft 修改）：空 tasks 不输出（plan/tasks 互斥）、空可选字段剔除', () => {
    const pkg: TaskPackage = {
      taskId: 'TASK-D', title: '草稿任务',
      repo: { url: 'http://gitea.inner.bank/admin/dome.git', branch: 'main' },
      tasks: [], // 计划模式包：后端 parseTaskPackage 视 tasks 在场为互斥冲突，必须剔除
      plan: [
        { id: 't1', title: '克隆仓库', detail: 'clone', verify: 'test -d .git' },
        { id: 't2', kind: 'devops', title: '部署', detail: 'deploy' },
      ],
    };
    const yaml = pkgToYaml(pkg);
    expect(yaml).toContain('taskId: TASK-D');
    expect(yaml).not.toContain('tasks:');
    expect(yaml).toContain('kind: devops');
    expect(yaml).not.toContain("kind: ''"); // 空 kind 不输出（t1 缺省 dev）
    expect(yaml).not.toContain('verify: deploy'); // t2 无 verify
    // 回填 yaml 可反解析回表单（零损失 round-trip）
    const back = yamlToPlanForm(yaml);
    expect(back.taskId).toBe('TASK-D');
    expect(back.plan).toHaveLength(2);
    expect(back.plan[1]!.kind).toBe('devops');
  });

  it('pkgToYaml：老包（tasks 非空）与可选字段（baseBranch/apiDocs/dependsOn 等）保留', () => {
    const pkg = {
      taskId: 'TASK-L', title: '老包',
      repo: { url: 'http://x/a.git', branch: 'dev', baseBranch: 'main' },
      tasks: [{ id: 'T-1', title: 's', files: ['a.ts'], requirement: 'r', acceptance: ['ok'] }],
      dependsOn: ['TASK-A'],
      apiDocs: 'http://docs/x',
      codingStandard: 'eslint',
      reportChannel: 'MR',
    } as unknown as TaskPackage;
    const raw = parseYaml(pkgToYaml(pkg)) as Record<string, unknown>;
    expect(raw['tasks']).toHaveLength(1); // 老包 tasks 原样保留
    expect((raw['repo'] as Record<string, unknown>)['baseBranch']).toBe('main');
    expect(raw['apiDocs']).toBe('http://docs/x');
    expect(raw['dependsOn']).toEqual(['TASK-A']);
  });
});
