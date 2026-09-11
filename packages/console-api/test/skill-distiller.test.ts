import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { FileSkillStore } from '../src/team/skill-store.js';
import {
  buildDistillSystemPrompt,
  createSkillDistiller,
  isDuplicateSkillCandidate,
  MAX_CANDIDATES_PER_TASK,
  normalizeSkillText,
} from '../src/team/skill-distiller.js';
import type { AgentEvent, TaskPackage } from '@ddw/runtime';

const task: TaskPackage = {
  taskId: 'T-DISTILL', title: '登录接口开发', repo: { url: 'http://x/a.git', branch: 'main' },
  tasks: [],
} as never;

const events: AgentEvent[] = [];
// EventStore 内存替身（形状对齐 src/stores/types.ts EventStore：append/list；list 忽略 filter 即可）
const memoryEvents = {
  append: async (e: AgentEvent) => { events.push(e); },
  list: async () => events,
};

let dir: string;
let store: FileSkillStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'distill-'));
  store = new FileSkillStore(join(dir, 'skills.json'));
  await store.ensureSeed();
  events.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 模型替身：返回固定 JSON 数组 */
const fakeGateway = (reply: string) => ({
  streamFnFor: () => async () => reply,
  modelFor: () => ({}),
}) as never;

const CANDIDATES = JSON.stringify([
  { categoryId: 'backend', type: 'knowledge', name: '登录限流经验', description: '登录接口限流策略', content: '登录失败 5 次锁定…' },
  { categoryId: 'backend', type: 'constraint', name: '密码不落日志', description: '安全约束', content: '任何日志不得输出明文密码' },
  { categoryId: 'nope', type: 'knowledge', name: '坏分类', description: '', content: 'x' },
]);

describe('skill-distiller（2026-09-06 自动沉淀）', () => {
  it('模型产出候选 → pending 入库，source=auto:<taskId>，坏分类条目跳过', async () => {
    const distill = createSkillDistiller({
      gateway: fakeGateway(`\`\`\`json\n${CANDIDATES}\n\`\`\``),
      skillStore: store, events: memoryEvents as never, workspaceRoot: dir,
    });
    const got = await distill({ task, employee: { id: 'emp-1', name: '甲', role: 'backend', skills: [] } as never });
    expect(got.length).toBe(2); // 第三条坏分类被跳过
    const all = await store.listSkills();
    expect(all.every((s) => s.status === 'pending')).toBe(true);
    expect(all.every((s) => s.source === 'auto:T-DISTILL')).toBe(true);
    expect(all.every((s) => s.sourceTaskId === 'T-DISTILL')).toBe(true);
  });

  it('每任务上限 2 条（MAX_CANDIDATES_PER_TASK）', async () => {
    expect(MAX_CANDIDATES_PER_TASK).toBe(2);
    // 终审 T7②：系统提示词「最多 N 条」必须与硬上限一致（曾写 3 条误导模型多产废候选）
    expect(buildDistillSystemPrompt(['backend'])).toContain('最多 2 条');
    const many = JSON.stringify(Array.from({ length: 5 }, (_, i) => ({
      categoryId: 'backend', type: 'knowledge', name: `经验${i}`, description: '', content: `c${i}`,
    })));
    const distill = createSkillDistiller({
      gateway: fakeGateway(many), skillStore: store, events: memoryEvents as never, workspaceRoot: dir,
    });
    const got = await distill({ task, employee: { id: 'emp-1', name: '甲', role: 'backend', skills: [] } as never });
    expect(got.length).toBe(2);
  });

  it('模型输出不可解析：返回空数组 + 事件留痕，不抛错', async () => {
    const distill = createSkillDistiller({
      gateway: fakeGateway('这不是 JSON'), skillStore: store, events: memoryEvents as never, workspaceRoot: dir,
    });
    const got = await distill({ task, employee: { id: 'emp-1', name: '甲', role: 'backend', skills: [] } as never });
    expect(got).toEqual([]);
    expect((await store.listSkills()).length).toBe(0);
    expect(events.some((e) => e.summary.includes('沉淀'))).toBe(true);
  });

  it('成功入库后追加留痕事件（summary 含「待审查」）', async () => {
    const distill = createSkillDistiller({
      gateway: fakeGateway(`\`\`\`json\n${CANDIDATES}\n\`\`\``),
      skillStore: store, events: memoryEvents as never, workspaceRoot: dir,
    });
    await distill({ task, employee: { id: 'emp-1', name: '甲', role: 'backend', skills: [] } as never });
    const e = events.find((ev) => ev.summary.includes('待审查'));
    expect(e).toBeDefined();
    expect((e!.payload as { skillPending?: boolean }).skillPending).toBe(true);
  });

  it('taskId 含 shell 注入字符：execFile 参数化执行，不注入不抛错（终审 I2）', async () => {
    const marker = `ddw-pwned-${Date.now()}-${process.pid}`;
    const evilTaskId = `" $(touch /tmp/${marker}) "`;
    const distill = createSkillDistiller({
      gateway: fakeGateway('[]'), skillStore: store, events: memoryEvents as never, workspaceRoot: dir,
    });
    const got = await distill({
      task: { ...task, taskId: evilTaskId } as never,
      employee: { id: 'emp-1', name: '甲', role: 'backend', skills: [] } as never,
    });
    expect(got).toEqual([]); // fakeGateway 返回 [] → 无可沉淀，全程不抛 shell 错误
    expect(events.some((e) => e.summary.includes('无可沉淀'))).toBe(true);
    // 注入命令未被执行：/tmp 与进程 cwd 均无含 marker 的产物文件
    //（RED 实证：exec 时代 shell 真执行了 touch——cwd 留下 _tmp_<marker> 残迹；execFile 后两处均无）
    const { readdir } = await import('node:fs/promises');
    const scan = async (d: string) => readdir(d).catch(() => [] as string[]);
    const everywhere = [...await scan('/tmp'), ...await scan('.')] as string[];
    expect(everywhere.some((f) => f.includes(marker))).toBe(false);
  }, 15_000);
});

describe('skill-distiller 跨任务去重（2026-09-08 遗留收尾）', () => {
  const employee = { id: 'emp-1', name: '甲', role: 'backend', skills: [] } as never;
  const distillWith = (reply: string) =>
    createSkillDistiller({
      gateway: fakeGateway(`\`\`\`json\n${reply}\n\`\`\``),
      skillStore: store, events: memoryEvents as never, workspaceRoot: dir,
    });

  it('归一化口径：trim + 去空白 + 小写（normalizeSkillText / isDuplicateSkillCandidate）', () => {
    expect(normalizeSkillText('  登录 限流 经验 \n')).toBe('登录限流经验');
    expect(normalizeSkillText('Login RateLimit')).toBe('loginratelimit');
    const cand = { name: '登录限流经验', content: '失败 5 次锁定' };
    expect(isDuplicateSkillCandidate(cand, { name: '登录限流经验', content: '不同正文' } as never)).toBe(true);
    expect(isDuplicateSkillCandidate(cand, { name: '别的经验', content: '失败 5 次锁定' } as never)).toBe(true);
    expect(isDuplicateSkillCandidate(cand, { name: '别的经验', content: '别的正文' } as never)).toBe(false);
  });

  it('同分类已有同标题 pending 候选 → 重复跳过不入库，事件留痕「重复跳过」', async () => {
    await store.upsertSkill({
      id: 'skill-old1', categoryId: 'backend', name: '登录限流经验', description: '', type: 'knowledge',
      content: '旧正文', status: 'pending', source: 'auto:T-OLD', createdAt: 1,
    });
    const got = await distillWith(JSON.stringify([
      { categoryId: 'backend', type: 'knowledge', name: '登录 限流经验', description: 'd', content: '全新正文写法不同' },
    ]))({ task, employee });
    expect(got).toEqual([]);
    expect(await store.listSkills()).toHaveLength(1); // 旧候选仍在，无新增
    const e = events.at(-1)!;
    expect(e.summary).toContain('重复跳过');
    expect((e.payload as { skillPending?: boolean }).skillPending).toBeUndefined();
  });

  it('不同知识（标题正文都不同）正常入库，跨任务不误杀', async () => {
    await store.upsertSkill({
      id: 'skill-old2', categoryId: 'backend', name: '登录限流经验', description: '', type: 'knowledge',
      content: '旧正文', status: 'pending', source: 'auto:T-OLD', createdAt: 1,
    });
    const got = await distillWith(JSON.stringify([
      { categoryId: 'backend', type: 'constraint', name: '日志脱敏规范', description: 'd', content: '日志不得含手机号' },
    ]))({ task, employee });
    expect(got).toHaveLength(1);
    expect(events.at(-1)!.summary).toContain('待审查');
    expect(await store.listSkills()).toHaveLength(2);
  });

  it('判定范围：approved 同样拦截（知识已生效），rejected 不拦截（人工否决可重提）', async () => {
    await store.upsertSkill({
      id: 'skill-ok', categoryId: 'backend', name: '已生效经验', description: '', type: 'knowledge',
      content: 'c1', status: 'approved', source: 'manual', createdAt: 1,
    });
    await store.upsertSkill({
      id: 'skill-no', categoryId: 'backend', name: '被否决经验', description: '', type: 'knowledge',
      content: 'c2', status: 'rejected', source: 'manual', createdAt: 1,
    });
    const got = await distillWith(JSON.stringify([
      { categoryId: 'backend', type: 'knowledge', name: '已生效经验', description: '', content: 'x' },
      { categoryId: 'backend', type: 'knowledge', name: '被否决经验', description: '', content: 'y' },
    ]))({ task, employee });
    expect(got).toHaveLength(1); // 仅 rejected 同名那条重新入库
    expect(got[0]!.name).toBe('被否决经验');
  });

  it('跨任务场景：任务 A 沉淀后任务 B 产出同分类同标题 → 跳过；不同分类同名 → 正常入库', async () => {
    const distillA = distillWith(JSON.stringify([
      { categoryId: 'backend', type: 'knowledge', name: '灰度发布经验', description: '', content: 'c' },
    ]));
    await distillA({ task, employee });
    // 任务 B（不同 taskId）产出同名候选（backend）+ 同名但不同分类（testing）
    const taskB = { ...task, taskId: 'T-DISTILL-B' } as never;
    const distillB = distillWith(JSON.stringify([
      { categoryId: 'backend', type: 'knowledge', name: '灰度发布经验', description: '', content: 'c2' },
      { categoryId: 'testing', type: 'knowledge', name: '灰度发布经验', description: '', content: 'c3' },
    ]));
    const gotB = await distillB({ task: taskB, employee });
    expect(gotB).toHaveLength(1);
    expect(gotB[0]!.categoryId).toBe('testing');
    const all = await store.listSkills();
    expect(all.filter((s) => s.categoryId === 'backend' && s.name === '灰度发布经验')).toHaveLength(1);
  });

  it('正文归一化相同（标题不同）也判重复；同批内第二条同名同样跳过', async () => {
    const got = await distillWith(JSON.stringify([
      { categoryId: 'backend', type: 'knowledge', name: '经验甲', description: '', content: '正文内容' },
      { categoryId: 'backend', type: 'knowledge', name: '经验乙', description: '', content: '正文 内容' },
    ]))({ task, employee });
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe('经验甲');
    expect(events.at(-1)!.summary).toContain('1 条重复跳过');
  });
});
