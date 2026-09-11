import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { ElMessage, ElMessageBox, type MessageBoxData } from 'element-plus';
import TaskCreateDialog from '../src/components/TaskCreateDialog.vue';
import { api, type EmployeeRecordView } from '../src/api.js';
import { planFormToYaml, type TaskFormState } from '../src/task-form.js';
import { mountWithEP } from './mount-helper.js';

vi.mock('../src/api.js', () => ({
  api: {
    listCapabilities: vi.fn(),
    createTask: vi.fn(),
    parseTask: vi.fn(),
    listEmployees: vi.fn(),
    listTasks: vi.fn(),
    listSkillCategories: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

// ElMessageBox.confirm 可控（反填老包防丢字段确认框），其余 element-plus 保持原样
const confirmSpy = vi.spyOn(ElMessageBox, 'confirm');
// ElMessage.error 打桩（智能生成失败透出后端文案，不真弹 toast）
const msgErrorSpy = vi.spyOn(ElMessage, 'error');

const mockedApi = vi.mocked(api, true);

const CAPS = [
  { kind: 'dev', name: '开发编码', tools: { builtin: ['bash', 'files'], mcp: [] }, enabled: true },
  { kind: 'commit', name: '代码提交', tools: { builtin: ['files'], mcp: ['forge'] }, enabled: true },
  { kind: 'devops', name: '发布部署', tools: { builtin: [], mcp: ['deploy'] }, enabled: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.listCapabilities.mockResolvedValue(CAPS);
  // dependsOn 多选数据源（Task 5）：缺省无既有任务
  mockedApi.listTasks.mockResolvedValue([]);
  // 岗位下拉数据源（2026-09-07 岗位即分类）：岗位管理清单（分类表）
  mockedApi.listSkillCategories.mockResolvedValue([
    { id: 'backend', name: '后端开发' }, { id: 'frontend', name: '前端开发' },
  ]);
});

const mountDialog = () => mountWithEP(TaskCreateDialog, { props: { modelValue: true } });
/** 表单模式挂载（2026-09-10 起新建默认 tab 为智能生成）：既有表单用例显式切表单再走原流程。
 *  setValue 触发的重渲染由调用方随后的 await flushPromises() 落地 */
const mountFormDialog = async () => {
  const wrapper = mountDialog();
  await flushPromises();
  await wrapper.find('[data-test="mode-form"] input').setValue(true);
  await flushPromises();
  return wrapper;
};
/** 表单模式保存（2026-09-06 动作按钮统一 footer）：先「生成 yaml 预览」切 yaml tab，再「保存为草稿」 */
const submitForm = async (wrapper: Awaited<ReturnType<typeof mountDialog>>): Promise<void> => {
  await wrapper.find('[data-test="preview-yaml"]').trigger('click');
  await flushPromises();
  await wrapper.find('[data-test="submit"]').trigger('click');
  await flushPromises();
};


const fillBasic = async (wrapper: Awaited<ReturnType<typeof mountDialog>>): Promise<void> => {
  // element-plus el-input 将 attrs（含 data-test）落到内部 input/textarea 元素上，故直接对 data-test 元素 setValue
  await wrapper.find('[data-test="f-task-id"]').setValue('feat-login');
  await wrapper.find('[data-test="f-title"]').setValue('登录功能开发');
  await wrapper.find('[data-test="f-repo-url"]').setValue('http://localhost:3000/demo/web-app.git');
  await wrapper.find('[data-test="f-branch"]').setValue('develop');
  // Task 5 起 role 为 el-select（teleported=false）：点开下拉点选岗位选项（2026-09-07 数据源为岗位清单，选项为岗位名）
  await wrapper.find('[data-test="f-role"]').trigger('click');
  await flushPromises();
  await wrapper.find('[data-test="role-option-后端开发"]').trigger('click');
  await flushPromises();
};

/** 切到 yaml 直贴模式（radio 原生 input 走 setValue 触发 change） */
const switchToYaml = async (wrapper: Awaited<ReturnType<typeof mountDialog>>): Promise<void> => {
  await wrapper.find('[data-test="mode-yaml"] input').setValue(true);
};
const switchToForm = async (wrapper: Awaited<ReturnType<typeof mountDialog>>): Promise<void> => {
  await wrapper.find('[data-test="mode-form"] input').setValue(true);
};

describe('TaskCreateDialog 任务创建双模式（2026-09-05）', () => {
  it('新建默认 tab 为智能生成（2026-09-10 用户需求）：AI 描述框在位，表单控件不渲染', async () => {
    const wrapper = mountDialog();
    await flushPromises();

    expect(wrapper.find('[data-test="mode-ai"]').classes()).toContain('is-active');
    expect(wrapper.find('[data-test="ai-description"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="f-task-id"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('打开时拉取能力注册表；kind 选项过滤 enabled，含空选项「(缺省 dev)」', async () => {
    const wrapper = await mountFormDialog();
    await flushPromises();

    expect(mockedApi.listCapabilities).toHaveBeenCalled();
    expect(wrapper.text()).toContain('(缺省 dev)');
    // exposed kindOptions：仅 enabled 能力可选（devops 停用被过滤）
    const exposed = wrapper.vm.kindOptions as () => typeof CAPS;
    expect(exposed().map((c) => c.kind)).toEqual(['dev', 'commit']);
  });

  it('表单模式 →「生成 yaml 预览」：切到 yaml tab 且内容预填（2026-09-06 用户偏好）', async () => {
    const wrapper = await mountFormDialog();
    await flushPromises();
    await fillBasic(wrapper);

    await wrapper.find('[data-test="preview-yaml"]').trigger('click');
    // 模式切到 yaml 直贴，预填内容出现在可编辑输入框（不再是页内只读框）
    expect(wrapper.find('[data-test="mode-yaml"]').classes()).toContain('is-active');
    const input = wrapper.find('[data-test="yaml-input"]');
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLTextAreaElement).value).toContain('taskId: feat-login');
    expect((input.element as HTMLTextAreaElement).value).toContain('plan:');
    expect(wrapper.find('[data-test="yaml-preview"]').exists()).toBe(false);
  });

  it('表单模式提交：先 planFormToYaml 再 createTask，成功后 created + 关闭', async () => {
    mockedApi.createTask.mockResolvedValue({ taskId: 'feat-login', status: 'pending' });
    const wrapper = await mountFormDialog();
    await flushPromises();
    await fillBasic(wrapper);
    await submitForm(wrapper);
    await flushPromises();

    const expected = planFormToYaml({
      taskId: 'feat-login', title: '登录功能开发', role: '后端开发',
      repoUrl: 'http://localhost:3000/demo/web-app.git', branch: 'develop',
      plan: [], // 默认空计划项行被序列化过滤
    } satisfies TaskFormState);
    expect(mockedApi.createTask).toHaveBeenCalledWith(expected);
    expect(wrapper.emitted('created')?.[0]).toEqual(['feat-login']);
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
  });

  it('yaml 直贴模式：textarea 原文提交 createTask（老入口行为等价）', async () => {
    mockedApi.createTask.mockResolvedValue({ taskId: 'TASK-1', status: 'pending' });
    const wrapper = await mountFormDialog();
    await flushPromises();

    await switchToYaml(wrapper);
    const raw = 'taskId: TASK-1\ntitle: x\nrepo: { url: "http://x/a.git", branch: main }\ntasks: []\n';
    await wrapper.find('[data-test="yaml-input"]').setValue(raw);
    await wrapper.find('[data-test="submit"]').trigger('click');
    await flushPromises();

    expect(mockedApi.createTask).toHaveBeenCalledWith(raw);
    expect(wrapper.emitted('created')?.[0]).toEqual(['TASK-1']);
  });

  it('「从 yaml 反填」：yaml（含 plan）→ 表单回填并切回表单模式', async () => {
    const wrapper = await mountFormDialog();
    await flushPromises();

    const raw = planFormToYaml({
      taskId: 'feat-login', title: '登录功能开发', role: 'backend',
      repoUrl: 'http://localhost:3000/demo/web-app.git', branch: 'develop',
      plan: [
        { id: 't1', kind: '', title: '开发登录接口', detail: '实现 POST /api/login', verify: '' },
        { id: 't2', kind: 'commit', title: '提交并建 MR', detail: '提交分支并建 MR', verify: 'npm run build' },
      ],
    });
    await switchToYaml(wrapper);
    await wrapper.find('[data-test="yaml-input"]').setValue(raw);
    await wrapper.find('[data-test="fill-from-yaml"]').trigger('click');
    await flushPromises();

    expect((wrapper.find('[data-test="f-task-id"]').element as HTMLInputElement).value).toBe('feat-login');
    const rows = wrapper.findAll('[data-test="plan-table"] .el-table__row');
    expect(rows.length).toBe(2);
  });

  it('「从 yaml 反填」老包（含 tasks 等）：确认后切表单并回填；取消则留在 yaml 模式', async () => {
    const wrapper = await mountFormDialog();
    await flushPromises();

    const legacyYaml = 'taskId: TASK-1\ntitle: x\nrepo: { url: "http://x/a.git", branch: main }\ntasks:\n  - taskId: s1\n    baseBranch: develop\n';
    await switchToYaml(wrapper);
    await wrapper.find('[data-test="yaml-input"]').setValue(legacyYaml);

    // 取消：不切模式，留在 yaml 直贴
    confirmSpy.mockRejectedValueOnce('cancel');
    await wrapper.find('[data-test="fill-from-yaml"]').trigger('click');
    await flushPromises();
    expect(confirmSpy).toHaveBeenCalled();
    expect(String(confirmSpy.mock.calls.at(-1)?.[0])).toContain('tasks');
    expect(wrapper.find('[data-test="yaml-input"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="plan-table"]').exists()).toBe(false);

    // 确认：切表单模式（老包字段丢失风险由用户自担）
    confirmSpy.mockResolvedValueOnce('confirm' as MessageBoxData);
    await wrapper.find('[data-test="fill-from-yaml"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="plan-table"]').exists()).toBe(true);
  });

  it('添加计划项：删除中间行后再添加，新行 id 不与既有 id 重复', async () => {
    const wrapper = await mountFormDialog();
    await flushPromises();

    // 初始 t1 + 添加 t2、t3，删除 t2（中间行），再添加 → 应为 t4 而非重复的 t3
    await wrapper.find('[data-test="add-row"]').trigger('click');
    await wrapper.find('[data-test="add-row"]').trigger('click');
    let rows = wrapper.findAll('[data-test="plan-table"] .el-table__row');
    await rows[1]!.findAll('button')[2]!.trigger('click');
    await wrapper.find('[data-test="add-row"]').trigger('click');
    rows = wrapper.findAll('[data-test="plan-table"] .el-table__row');
    expect(rows.length).toBe(3);
    const ids = rows.map((r) => (r.find('input').element as HTMLInputElement).value);
    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe('t4');
  });

  it('计划项操作：添加一行、上移/下移、删除', async () => {
    const wrapper = await mountFormDialog();
    await flushPromises();

    await wrapper.find('[data-test="add-row"]').trigger('click');
    await wrapper.find('[data-test="add-row"]').trigger('click');
    let rows = wrapper.findAll('[data-test="plan-table"] .el-table__row');
    expect(rows.length).toBe(3);

    // 上移第二行（首行上移按钮禁用）
    await rows[1]!.findAll('button')[0]!.trigger('click');
    await rows[0]!.findAll('button')[0]!.trigger('click'); // 首行禁用，顺序不变
    // 删除最后一行
    await rows[2]!.findAll('button')[2]!.trigger('click');
    rows = wrapper.findAll('[data-test="plan-table"] .el-table__row');
    expect(rows.length).toBe(2);
  });

  it('提交失败：后端 400 message 原样展示，对话框保持打开', async () => {
    mockedApi.createTask.mockRejectedValue(new Error("任务项 t1.kind='dev' 未注册或已停用"));
    const wrapper = await mountFormDialog();
    await flushPromises();
    await submitForm(wrapper);
    await flushPromises();

    expect(wrapper.find('[data-test="error"]').text()).toContain("任务项 t1.kind='dev' 未注册或已停用");
    expect(wrapper.find('[data-test="yaml-input"]').exists()).toBe(true); // 停在 yaml 模式（表单保存经预览切换），对话框未关闭
    expect(wrapper.emitted('update:modelValue')).toBeUndefined(); // 未关闭
  });
});

describe('TaskCreateDialog 智能生成第三模式（终审 G1，2026-09-06）', () => {
  /** 切到智能生成模式 */
  const switchToAi = async (wrapper: Awaited<ReturnType<typeof mountDialog>>): Promise<void> => {
    await wrapper.find('[data-test="mode-ai"] input').setValue(true);
  };

  it('智能生成模式：大文本框 + 「AI 生成」按钮，点击调用 parseTask 且参数为输入描述', async () => {
    mockedApi.parseTask.mockResolvedValue({ yaml: 'taskId: x\n' });
    const wrapper = await mountFormDialog();
    await flushPromises();

    await switchToAi(wrapper);
    expect(wrapper.find('[data-test="ai-description"]').exists()).toBe(true);
    await wrapper.find('[data-test="ai-description"]').setValue('开发一个登录接口，支持账号密码登录');

    await wrapper.find('[data-test="ai-generate"]').trigger('click');
    await flushPromises();

    expect(mockedApi.parseTask).toHaveBeenCalledTimes(1);
    expect(mockedApi.parseTask).toHaveBeenCalledWith('开发一个登录接口，支持账号密码登录');
  });

  it('生成成功：自动切到 yaml 模式并预填后端返回内容（用户检查/修改后确认添加）', async () => {
    const yaml = 'taskId: feat-login\ntitle: 登录功能\nrepo: { url: "http://x/a.git", branch: main }\nplan: []\n';
    mockedApi.parseTask.mockResolvedValue({ yaml });
    const wrapper = await mountFormDialog();
    await flushPromises();

    await switchToAi(wrapper);
    await wrapper.find('[data-test="ai-description"]').setValue('做一个登录功能');
    await wrapper.find('[data-test="ai-generate"]').trigger('click');
    await flushPromises();

    // 已切到 yaml 模式：yaml 文本框在位且预填生成结果，ai 文本框不在
    expect(wrapper.find('[data-test="yaml-input"]').exists()).toBe(true);
    expect((wrapper.find('[data-test="yaml-input"]').element as HTMLTextAreaElement).value).toBe(yaml);
    expect(wrapper.find('[data-test="ai-description"]').exists()).toBe(false);
  });

  it('生成失败（后端 400）：ElMessage.error 原样文案，不切换模式', async () => {
    mockedApi.parseTask.mockRejectedValue(new Error('未启用智能生成（未配置模型）'));
    const wrapper = await mountFormDialog();
    await flushPromises();

    await switchToAi(wrapper);
    await wrapper.find('[data-test="ai-description"]').setValue('做一个登录功能');
    await wrapper.find('[data-test="ai-generate"]').trigger('click');
    await flushPromises();

    expect(msgErrorSpy).toHaveBeenCalledWith('未启用智能生成（未配置模型）');
    // 仍留在智能生成模式，未切 yaml、未关闭对话框
    expect(wrapper.find('[data-test="ai-description"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="yaml-input"]').exists()).toBe(false);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('生成后确认添加：走 createTask（后端默认 draft），yaml 原文提交', async () => {
    const yaml = 'taskId: feat-login\ntitle: 登录功能\nrepo: { url: "http://x/a.git", branch: main }\nplan: []\n';
    mockedApi.parseTask.mockResolvedValue({ yaml });
    mockedApi.createTask.mockResolvedValue({ taskId: 'feat-login', status: 'draft' });
    const wrapper = await mountFormDialog();
    await flushPromises();

    await switchToAi(wrapper);
    await wrapper.find('[data-test="ai-description"]').setValue('做一个登录功能');
    await wrapper.find('[data-test="ai-generate"]').trigger('click');
    await flushPromises();

    await wrapper.find('[data-test="submit"]').trigger('click');
    await flushPromises();

    expect(mockedApi.createTask).toHaveBeenCalledTimes(1);
    expect(mockedApi.createTask).toHaveBeenCalledWith(yaml);
    expect(wrapper.emitted('created')?.[0]).toEqual(['feat-login']);
  });

  it('生成中按钮 loading，pending 期间重复点击不重复调用 parseTask', async () => {
    let resolveFn!: (v: { yaml: string }) => void;
    mockedApi.parseTask.mockImplementation(() => new Promise((res) => { resolveFn = res; }));
    const wrapper = await mountFormDialog();
    await flushPromises();

    await switchToAi(wrapper);
    await wrapper.find('[data-test="ai-description"]').setValue('做一个登录功能');
    const btn = wrapper.find('[data-test="ai-generate"]');
    await btn.trigger('click');
    expect(mockedApi.parseTask).toHaveBeenCalledTimes(1);
    expect(btn.classes()).toContain('is-loading');

    await btn.trigger('click'); // pending 期间再点
    expect(mockedApi.parseTask).toHaveBeenCalledTimes(1);

    resolveFn({ yaml: 'taskId: x\n' });
    await flushPromises();
    expect(wrapper.find('[data-test="yaml-input"]').exists()).toBe(true);
  });
});

describe('TaskCreateDialog 创建对话框下拉化（Task 5，2026-09-06）', () => {
  const EMPLOYEES: EmployeeRecordView[] = [
    { id: 'emp-1', name: '张后端', roles: ['backend'], capabilities: [], enabled: true, supervision: 'trusted', busy: false, runningTasks: [] },
    { id: 'emp-2', name: '李前端', roles: ['frontend'], capabilities: [], enabled: true, supervision: 'trusted', busy: false, runningTasks: [] },
  ];
  const TASKS = [
    { taskId: 'TASK-A', title: '任务A', status: 'draft' as const, hasResult: false },
    { taskId: 'TASK-B', title: '任务B', status: 'done' as const, hasResult: true },
  ];

  it('岗位下拉数据源为岗位清单（不再取员工 skills 并集），且不可自由创建', async () => {
    // 员工 skills 含 test 等非岗位值：若仍取并集会污染选项——用于反向验证
    mockedApi.listEmployees.mockResolvedValue(EMPLOYEES.map((e) => ({ ...e })));
    mockedApi.listTasks.mockResolvedValue(TASKS.map((t) => ({ ...t })));
    const wrapper = await mountFormDialog();
    await flushPromises();

    // 岗位清单接口被拉取；员工列表不再作为岗位数据源（不再调用）
    expect(mockedApi.listSkillCategories).toHaveBeenCalled();
    expect(mockedApi.listEmployees).not.toHaveBeenCalled();
    expect(mockedApi.listTasks).toHaveBeenCalled();

    // 断言1：岗位下拉选项 = 岗位名（岗位清单），不出现员工 skills 独有值（test）
    await wrapper.find('[data-test="f-role"]').trigger('click');
    await flushPromises();
    const opts = wrapper.findAll('[data-test^="role-option-"]').map((o) => o.text());
    expect(new Set(opts)).toEqual(new Set(['后端开发', '前端开发']));
    expect(opts).not.toContain('test');
    await wrapper.find('[data-test="f-role"]').trigger('click'); // 收起
    await flushPromises();

    // 断言2：allow-create 已移除——EP select 无自由创建行为（岗位受管，不可输入任意值）
    const roleSelect = wrapper.findAllComponents({ name: 'ElSelect' })
      .find((c) => c.attributes('data-test') === 'f-role');
    expect(roleSelect).toBeTruthy();
    expect(roleSelect!.props('allowCreate')).toBeFalsy();

    // dependsOn 下拉：已有任务 TASK-A/TASK-B（label = taskId + 标题）
    await wrapper.find('[data-test="f-depends-on"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-test^="dep-option-"]').map((o) => o.text())).toEqual([
      'TASK-A 任务A', 'TASK-B 任务B',
    ]);

    // 任务 ID 填 TASK-A 后：依赖选项排除自身，仅剩 TASK-B
    await wrapper.find('[data-test="f-task-id"]').setValue('TASK-A');
    await flushPromises();
    expect(wrapper.findAll('[data-test^="dep-option-"]').map((o) => o.text())).toEqual(['TASK-B 任务B']);
  });

  it('提交 yaml 含所选依赖（form.dependsOn 序列化进 createTask 的 yaml）', async () => {
    mockedApi.listEmployees.mockResolvedValue(EMPLOYEES.map((e) => ({ ...e })));
    mockedApi.listTasks.mockResolvedValue(TASKS.map((t) => ({ ...t })));
    mockedApi.createTask.mockResolvedValue({ taskId: 'feat-login', status: 'draft' });
    const wrapper = await mountFormDialog();
    await flushPromises();

    await wrapper.find('[data-test="f-task-id"]').setValue('feat-login');
    await wrapper.find('[data-test="f-depends-on"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="dep-option-TASK-B"]').trigger('click');
    await flushPromises();
    await submitForm(wrapper);
    await flushPromises();

    expect(mockedApi.createTask).toHaveBeenCalledTimes(1);
    const yaml = mockedApi.createTask.mock.calls[0]![0] as string;
    expect(yaml).toContain('dependsOn:');
    expect(yaml).toContain('- TASK-B');
  });

  it('防自依赖（终审 I-1）：先选依赖再改 taskId 为该依赖，提交 yaml 不含自依赖（trim 比较剔除）', async () => {
    mockedApi.listEmployees.mockResolvedValue(EMPLOYEES.map((e) => ({ ...e })));
    mockedApi.listTasks.mockResolvedValue(TASKS.map((t) => ({ ...t })));
    mockedApi.createTask.mockResolvedValue({ taskId: 'TASK-B', status: 'draft' });
    const wrapper = await mountFormDialog();
    await flushPromises();

    // 先选依赖 TASK-B，再把任务 ID 改成 TASK-B：已选值不得残留自身
    await wrapper.find('[data-test="f-task-id"]').setValue('feat-login');
    await wrapper.find('[data-test="f-depends-on"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="dep-option-TASK-B"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="f-task-id"]').setValue('TASK-B');
    await flushPromises();
    await submitForm(wrapper);
    await flushPromises();
    let yaml = mockedApi.createTask.mock.calls.at(-1)![0] as string;
    expect(yaml).toContain('taskId: TASK-B');
    expect(yaml).not.toContain('dependsOn:');

    // trim 比较：依赖已选 TASK-B 后任务 ID 改为「 TASK-B 」（带空格）同样剔除
    await switchToForm(wrapper); // 第一次提交后停在 yaml 模式，切回表单继续
    await flushPromises();
    await wrapper.find('[data-test="f-task-id"]').setValue('feat-login');
    await flushPromises();
    await wrapper.find('[data-test="f-depends-on"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="dep-option-TASK-B"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="f-task-id"]').setValue(' TASK-B ');
    await flushPromises();
    await submitForm(wrapper);
    await flushPromises();
    yaml = mockedApi.createTask.mock.calls.at(-1)![0] as string;
    expect(yaml).toContain('taskId: TASK-B'); // planFormToYaml 对 taskId 做了 trim
    expect(yaml).not.toContain('dependsOn:');
  });

  it('岗位/依赖接口失败不阻塞对话框：role 无选项仍可提交（可空 = 不限），依赖可不选照常提交', async () => {
    mockedApi.listSkillCategories.mockRejectedValue(new Error('cats down'));
    mockedApi.listTasks.mockRejectedValue(new Error('tasks down'));
    mockedApi.createTask.mockResolvedValue({ taskId: 'feat-login', status: 'draft' });
    const wrapper = await mountFormDialog();
    await flushPromises();

    await wrapper.find('[data-test="f-task-id"]').setValue('feat-login');
    await wrapper.find('[data-test="f-role"]').trigger('click');
    expect(wrapper.findAll('[data-test^="role-option-"]').length).toBe(0); // 无选项可选（岗位清单失败保持空数组）
    await submitForm(wrapper);
    await flushPromises();

    expect(mockedApi.createTask).toHaveBeenCalledTimes(1);
    const yaml = mockedApi.createTask.mock.calls[0]![0] as string;
    expect(yaml).not.toContain('dependsOn:');
    expect(wrapper.emitted('created')?.[0]).toEqual(['feat-login']);
  });
});

describe('TaskCreateDialog 创建与分派分离（2026-09-06）', () => {
  it('创建表单不再有「指定员工」下拉：填写提交 yaml 不含 assignee（分派移至任务列表页）', async () => {
    mockedApi.listEmployees.mockResolvedValue([
      { id: 'emp-1', name: '张后端', roles: ['backend'], capabilities: [], enabled: true, supervision: 'trusted', busy: false, runningTasks: [] },
    ]);
    mockedApi.createTask.mockResolvedValue({ taskId: 'feat-login', status: 'draft' });
    const wrapper = await mountFormDialog();
    await flushPromises();

    // 「指定员工」el-col 已撤：创建不指明员工
    expect(wrapper.find('[data-test="assignee-select"]').exists()).toBe(false);
    await submitForm(wrapper);
    await flushPromises();
    expect(mockedApi.createTask).toHaveBeenCalledTimes(1);
    expect(mockedApi.createTask.mock.calls[0]![0] as string).not.toContain('assignee');
  });

  it('智能生成模式隐藏「保存为草稿」按钮；生成成功切 yaml 模式后出现（流程不变），取消按钮始终保留', async () => {
    const wrapper = await mountFormDialog();
    await flushPromises();
    // form 模式 footer 动作是「生成 yaml 预览」（primary），submit 不在
    expect(wrapper.find('[data-test="preview-yaml"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="submit"]').exists()).toBe(false);

    // ai 模式：无产出保存无意义 → submit 隐藏，取消保留
    await wrapper.find('[data-test="mode-ai"] input').setValue(true);
    expect(wrapper.find('[data-test="submit"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('取消');

    // 生成成功 → 自动切 yaml 模式，submit 出现
    mockedApi.parseTask.mockResolvedValue({ yaml: 'taskId: x\n' });
    await wrapper.find('[data-test="ai-description"]').setValue('做一个登录功能');
    await wrapper.find('[data-test="ai-generate"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="yaml-input"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="submit"]').exists()).toBe(true);
  });
});
