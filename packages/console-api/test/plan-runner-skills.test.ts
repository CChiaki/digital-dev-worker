import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTaskPlan, type PlanRunInput } from '../src/team/plan-runner.js';
import { CAPABILITY_PRESETS } from '../src/team/capabilities.js';
import { EventBus, ToolRegistry } from '@ddw/runtime';
import type { AgentFactory, EmployeeProfile, ModelGateway, PlanItem, TaskPackage } from '@ddw/runtime';
import type { SkillRecord } from '../src/team/skill-injection.js';

/**
 * 计划执行器 Skill 注入（2026-09-06）单测：
 * 复用 plan-runner.test.ts 的 faux agent 装配方式（pi Agent 协议：subscribe/prompt/steer/state，
 * prompt 收到的 instruction 字符串即员工实际拿到的指令）——capture 后断言含/不含「## 技能与约束」。
 * asset 落盘在 executor 层测试覆盖，此处仅断言清单注入与文件真实写入。
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-plan-runner-skills-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const pkg: TaskPackage & { plan: PlanItem[] } = {
  taskId: 'T-SKILL', title: '技能注入', repo: { url: 'http://x/a.git', branch: 'main' }, tasks: [],
  plan: [{ id: 't1', kind: 'dev', title: '开发', detail: '实现' }],
};

const emp: EmployeeProfile = { id: 'emp-01', name: '员工01', role: 'dev', skills: ['dev'] };

/** faux agent 工厂：prompt 即结束（prompt 即结束 → outcome done），把收到的指令原文捕获供断言 */
const recordingAgentFactory = (captured: string[]): AgentFactory => () =>
  ({
    subscribe: () => () => {},
    prompt: async (instruction: string) => {
      captured.push(instruction);
    },
    steer: () => false,
    state: { messages: [] },
  }) as never;

/** faux gateway：faux agent 不触达模型，仅组装时解析路由需方法在场 */
const fauxGateway = {
  modelFor: () => ({}),
  streamFnFor: () => (async () => {}) as never,
} as unknown as ModelGateway;

const skill = (over: Partial<SkillRecord>): SkillRecord => ({
  id: 'skill-s1', categoryId: 'backend', name: '规范', description: '', type: 'knowledge',
  content: '异常码以 E 开头', status: 'approved', source: 'manual', createdAt: 1, ...over,
});

function makeInput(captured: string[], skills?: SkillRecord[]): PlanRunInput {
  const workspaceDir = join(root, 'ws');
  const events = new EventBus();
  events.addSink({ write: async () => {} });
  return {
    pkg, employee: emp,
    workspaceDir, sessionsRoot: join(root, 'sessions'),
    gateway: fauxGateway, events,
    capabilities: async () => CAPABILITY_PRESETS.map((d) => ({ ...d })),
    agentFactory: recordingAgentFactory(captured),
    toolsForItem: () => new ToolRegistry(),
    ...(skills ? { skills } : {}),
  } as PlanRunInput;
}

describe('plan-runner Skill 注入（2026-09-06）', () => {
  it('skills 在场：指令追加「技能与约束」段，正文可被员工看到', async () => {
    const captured: string[] = [];
    const outcome = await runTaskPlan(makeInput(captured, [skill({})]));
    expect(outcome.status).toBe('done');
    expect(captured[0]).toContain('## 技能与约束');
    expect(captured[0]).toContain('异常码以 E 开头');
  });

  it('skills 缺省/空数组：指令零改动（零回归，空数组零开销路径）', async () => {
    const captured: string[] = [];
    await runTaskPlan(makeInput(captured));
    expect(captured[0]).not.toContain('## 技能与约束');
    const capturedEmpty: string[] = [];
    await runTaskPlan(makeInput(capturedEmpty, []));
    expect(capturedEmpty[0]).not.toContain('## 技能与约束');
  });

  it('asset skill：正文不注入、清单注入，文件真实落盘 workspace/.skills/', async () => {
    const captured: string[] = [];
    const wsDir = join(root, 'ws');
    // 终审 T5①：去掉 content:''，保留默认正文——not.toContain 才有判别力（否则正文本来就是空）
    await runTaskPlan({
      ...makeInput(captured, [skill({ id: 'skill-a9', type: 'asset', assetFiles: [{ path: 'x.sh', content: 'y' }] })]),
    });
    expect(captured[0]).toContain('.skills/skill-a9/x.sh');
    expect(captured[0]).not.toContain('异常码以 E 开头');
    // asset 落盘（plan-runner 层一次落盘，整计划共用）：文件真实写入
    expect(existsSync(join(wsDir, '.skills', 'skill-a9', 'x.sh'))).toBe(true);
  });
});
