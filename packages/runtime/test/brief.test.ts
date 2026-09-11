import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTaskBrief, buildPlanItemInstruction } from '../src/task/brief.js';
import { parseTaskPackage } from '../src/task/package.js';
import type { TaskPackage, PlanItem } from '../src/task/package.js';
import { EmployeeRuntime, type AgentFactory } from '../src/runtime/employee-runtime.js';
import { ModelGateway } from '../src/model/gateway.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { EmployeeSessionStore, loadMessages } from '../src/session/employee-session.js';
import { EventBus } from '../src/events/bus.js';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux';
import type { ModelSpec, RouteConfig } from '../src/types.js';

const yaml = `
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
    requirement: 拆分表单子组件
    acceptance:
      - build 通过
apiDocs: http://gitlab.inner.bank/api-docs/auth.md
codingStandard: 遵循团队 Vue 规范
reportChannel: 完成后在 MR 描述附 Jira 单号
`;

describe('buildTaskBrief', () => {
  it('任务简报包含任务包全部关键信息', () => {
    const pkg = parseTaskPackage(yaml);
    const brief = buildTaskBrief(pkg);

    expect(brief).toContain('TASK-2026-0912-001');
    expect(brief).toContain('登录模块前端重构');
    expect(brief).toContain('feature/login-refactor');
    expect(brief).toContain('develop');
    expect(brief).toContain('src/views/login/index.vue');
    expect(brief).toContain('拆分表单子组件');
    expect(brief).toContain('build 通过');
    expect(brief).toContain('api-docs/auth.md');
    expect(brief).toContain('团队 Vue 规范');
    expect(brief).toContain('Jira 单号');
  });

  it('简报含工作约定（用工具干活/自测/汇报）', () => {
    const brief = buildTaskBrief(parseTaskPackage(yaml));
    expect(brief).toContain('工作约定');
    expect(brief).toMatch(/gitlab_/);
  });

  it('runTaskPackage 端到端：简报作为首条任务指令进入上下文', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddw-brief-'));
    try {
      const spec: ModelSpec = { name: 'qwen', baseUrl: 'http://model.local/v1', apiKey: 'k', model: 'qwen3.8-27b' };
      const routes: RouteConfig[] = [{ callType: 'code', primary: spec }];
      const factory: AgentFactory = (opts) => {
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        faux.setResponses([fauxAssistantMessage(fauxText('已完成全部任务'))]);
        return new Agent({
          initialState: {
            systemPrompt: opts.systemPrompt, model: faux.getModel(), tools: opts.tools,
          },
          streamFn: models.streamSimple.bind(models),
        });
      };

      const events = new EventBus();
      const tools = new ToolRegistry();
      const rt = new EmployeeRuntime({
        gateway: new ModelGateway(routes), tools, interceptors: [], events,
        sessions: new EmployeeSessionStore(root),
        config: { employeeId: 'emp-01' },
        agentFactory: factory,
      });

      const outcome = await rt.runTaskPackage(parseTaskPackage(yaml));
      expect(outcome.status).toBe('done');
      expect(outcome.reply).toBe('已完成全部任务');

      // 首条指令 = 任务简报（含分支与文件）
      const msgs = await loadMessages(await new EmployeeSessionStore(root).open('TASK-2026-0912-001'));
      expect(JSON.stringify(msgs[0])).toContain('feature/login-refactor');
      expect(JSON.stringify(msgs[0])).toContain('src/views/login/index.vue');
      await rm(root, { recursive: true, force: true });
    } finally {
      void 0;
    }
  });
});

const planPkg: TaskPackage = {
  taskId: 'feat-login', title: '登录功能开发',
  repo: { url: 'http://localhost:3000/demo/web-app.git', branch: 'develop' },
  tasks: [],
};
const planItem: PlanItem = { id: 't2', kind: 'test', title: 'e2e 测试登录', detail: '覆盖正确/错误密码', verify: 'npm run e2e' };

describe('buildPlanItemInstruction（计划项指令，2026-09-05）', () => {
  it('包含序号/kind/标题/要求/验证命令/task_check 申报指引', () => {
    const s = buildPlanItemInstruction(planPkg, planItem, 1, 3, ['t1 开发登录接口：已完成（构建通过）']);
    expect(s).toContain('第 2/3 项');
    expect(s).toContain('e2e 测试登录');
    expect(s).toContain('覆盖正确/错误密码');
    expect(s).toContain('npm run e2e');
    expect(s).toContain('task_check');
    expect(s).toContain('t2');
    expect(s).toContain('t1 开发登录接口：已完成（构建通过）'); // 前序项结果摘要
  });
});
