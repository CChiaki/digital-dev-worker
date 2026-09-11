import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { ElMessage } from 'element-plus';
import TaskCenter from '../src/views/TaskCenter.vue';
import TaskDetail from '../src/views/TaskDetail.vue';
import { api } from '../src/api.js';
import { mountWithEP, makeTestRouter, mountWithRouter } from './mount-helper.js';

vi.mock('../src/api.js', () => ({
  api: {
    listTasks: vi.fn(),
    getTask: vi.fn(),
    createTask: vi.fn(),
    claimTask: vi.fn(),
    listEvents: vi.fn(),
    auditTask: vi.fn(),
    listCapabilities: vi.fn(),
    publishTask: vi.fn(),
    assignTask: vi.fn(),
    listEmployees: vi.fn(),
  },
  claimId: () => 'emp-01',
}));

const mockedApi = vi.mocked(api, true);

/** TaskDetail 通用 mock：节点事件为空、审计聚合返回空档案 */
beforeEach(() => {
  mockedApi.listEvents.mockResolvedValue([] as never);
  mockedApi.auditTask.mockResolvedValue({
    task: SAMPLE_TASK, timeline: [], toolCalls: [], reply: undefined,
  } as never);
});

const SAMPLE_TASK = {
  pkg: {
    taskId: 'TASK-2026-0912-001',
    title: '登录模块前端重构',
    repo: { url: 'http://gitlab.inner.bank/frontend/web-app.git', branch: 'feature/login-refactor', baseBranch: 'develop' },
    tasks: [{ id: 'T-1', title: '登录页组件拆分', files: ['src/views/login/index.vue'], requirement: '拆分', acceptance: ['npm run build 通过'] }],
  },
  status: 'pending' as const,
  hasResult: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

/** 员工名册 fixture（2026-09-06 姓名显示）：emp-1=张后端（启用）/ emp-2=李停用（停用） */
const EMPLOYEES = [
  { id: 'emp-1', name: '张后端', roles: ['backend'], capabilities: [], enabled: true, supervision: 'trusted' as const, busy: false, runningTasks: [] },
  { id: 'emp-2', name: '李停用', roles: ['frontend'], capabilities: [], enabled: false, supervision: 'trusted' as const, busy: false, runningTasks: [] },
];

describe('TaskCenter 任务中心', () => {
  /** 路由化（Task 7）：组件内 useRouter → 挂 memory-history router 后 mount */
  function mountCenter() {
    const router = makeTestRouter([
      { path: '/tasks', component: TaskCenter },
      { path: '/tasks/:id', component: { template: '<div data-test="detail-stub" />' } },
    ]);
    return mountWithRouter(TaskCenter, { router, path: '/tasks' });
  }

  /** 三个种子任务：draft / running / failed，供检索过滤与操作列用例复用 */
  function stubThreeTasks() {
    mockedApi.listTasks.mockResolvedValue([
      { taskId: 'TASK-A', title: '登录模块前端重构', status: 'draft', hasResult: false },
      { taskId: 'TASK-B', title: '转账联调', status: 'running', claimedBy: 'emp-01', hasResult: false },
      { taskId: 'TASK-C', title: '报表导出修复', status: 'failed', hasResult: true },
    ] as never);
  }

  /** el-table 行：jsdom 下直接查 .el-table__row（见 channels.test.ts 同款用法） */
  function rows(wrapper: Awaited<ReturnType<typeof mountCenter>>) {
    return wrapper.findAll('[data-test="task-table"] .el-table__row');
  }

  it('渲染任务表格与状态徽章', async () => {
    mockedApi.listTasks.mockResolvedValue([
      { taskId: 'TASK-1', title: '登录模块前端重构', status: 'pending', hasResult: false },
      { taskId: 'TASK-2', title: '报表导出后端', status: 'done', claimedBy: 'emp-01', hasResult: true },
    ]);
    const wrapper = await mountCenter();
    await flushPromises();
    const tableRows = rows(wrapper);
    expect(tableRows.length).toBe(2);
    expect(tableRows[0]!.text()).toContain('TASK-1');
    expect(tableRows[0].find('[data-test="badge"]').text()).toBe('待分派');
    expect(tableRows[1].find('[data-test="badge"]').text()).toBe('已完成');
  });

  it('领取人列显示姓名：映射命中显示姓名，未命中回退原 id（2026-09-06）', async () => {
    mockedApi.listTasks.mockResolvedValue([
      { taskId: 'TASK-N1', title: '已领取任务', status: 'running', claimedBy: 'emp-1', hasResult: false },
      { taskId: 'TASK-N2', title: '草稿点名任务', status: 'draft', assignee: 'emp-1', hasResult: false },
      { taskId: 'TASK-N3', title: '未知员工任务', status: 'running', claimedBy: 'emp-x', hasResult: false },
    ] as never);
    mockedApi.listEmployees.mockResolvedValue(EMPLOYEES as never);
    const wrapper = await mountCenter();
    await flushPromises();

    const [claimedRow, assignedRow, unknownRow] = rows(wrapper);
    // 领取人 emp-1 → 张后端（不显示 id）
    expect(claimedRow!.text()).toContain('张后端');
    expect(claimedRow!.text()).not.toContain('emp-1');
    // 已指定（未领取）→ 「已指定 张后端」
    expect(assignedRow!.text()).toContain('已指定 张后端');
    // 映射无该 id → 回退显示原 id，不得显示空白
    expect(unknownRow!.text()).toContain('emp-x');
  });

  it('行点击 → router.push 进入详情', async () => {
    mockedApi.listTasks.mockResolvedValue([
      { taskId: 'TASK-1', title: '登录模块前端重构', status: 'pending', hasResult: false },
    ]);
    const router = makeTestRouter([
      { path: '/tasks', component: TaskCenter },
      { path: '/tasks/:id', component: { template: '<div />' } },
    ]);
    const wrapper = await mountWithRouter(TaskCenter, { router, path: '/tasks' });
    // router 就绪后再 spy（否则 mount 里的初始导航被 mock，isReady 永挂起）
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined as never);
    await flushPromises();

    await rows(wrapper)[0]!.trigger('click');
    expect(push).toHaveBeenCalledWith('/tasks/TASK-1');
  });

  it('检索区：关键词与状态筛选过滤表格行', async () => {
    stubThreeTasks();
    const wrapper = await mountCenter();
    await flushPromises();
    expect(rows(wrapper).length).toBe(3);

    // 关键词匹配 taskId / 标题
    await wrapper.find('[data-test="search-input"]').setValue('TASK-A');
    expect(rows(wrapper)).toHaveLength(1);
    await wrapper.find('[data-test="search-input"]').setValue('登录模块');
    expect(rows(wrapper)).toHaveLength(1);
    await wrapper.find('[data-test="search-input"]').setValue('');

    // 状态多选（空 = 全部）
    await wrapper.find('[data-test="status-filter"]').trigger('click');
    await flushPromises();
    const options = wrapper.findAll('.el-select-dropdown__item');
    expect(options.map((o) => o.text())).toEqual(['待发布', '待分派', '已接单', '执行中', '已完成', '失败']);
    await options[5]!.trigger('click'); // failed
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(1);
    expect(rows(wrapper)[0]!.text()).toContain('失败');
    expect(rows(wrapper)[0]!.text()).toContain('TASK-C');
  });

  it('表格操作列：draft 行有「发布」，running 行有「直播」，done 行只有「详情」', async () => {
    mockedApi.listTasks.mockResolvedValue([
      { taskId: 'TASK-D', title: '草稿任务', status: 'draft', hasResult: false },
      { taskId: 'TASK-R', title: '执行中任务', status: 'running', claimedBy: 'emp-01', hasResult: false },
      { taskId: 'TASK-F', title: '完成任务', status: 'done', claimedBy: 'emp-02', hasResult: true },
    ] as never);
    const router = makeTestRouter([
      { path: '/tasks', component: TaskCenter },
      { path: '/tasks/:id', component: { template: '<div />' } },
      { path: '/employees/:id/live', component: { template: '<div />' } },
    ]);
    const wrapper = await mountWithRouter(TaskCenter, { router, path: '/tasks' });
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined as never);
    await flushPromises();

    const [draftRow, runningRow, doneRow] = rows(wrapper);
    // draft：详情 + 编辑 + 发布
    expect(draftRow!.find('[data-test="detail-btn"]').exists()).toBe(true);
    expect(draftRow!.find('[data-test="edit-btn"]').exists()).toBe(true);
    expect(draftRow!.find('[data-test="publish-btn"]').exists()).toBe(true);
    expect(draftRow!.find('[data-test="live-btn"]').exists()).toBe(false);
    // running：详情 + 直播（跳执行员工 live 页）
    expect(runningRow!.find('[data-test="detail-btn"]').exists()).toBe(true);
    expect(runningRow!.find('[data-test="live-btn"]').exists()).toBe(true);
    expect(runningRow!.find('[data-test="publish-btn"]').exists()).toBe(false);
    expect(runningRow!.find('[data-test="edit-btn"]').exists()).toBe(false);
    await runningRow!.find('[data-test="live-btn"]').trigger('click');
    expect(push).toHaveBeenCalledWith('/employees/emp-01/live');
    // done：只有详情
    expect(doneRow!.find('[data-test="detail-btn"]').exists()).toBe(true);
    expect(doneRow!.find('[data-test="publish-btn"]').exists()).toBe(false);
    expect(doneRow!.find('[data-test="live-btn"]').exists()).toBe(false);
    // 操作按钮 @click.stop：不触发行跳转
    push.mockClear();
    await doneRow!.find('[data-test="detail-btn"]').trigger('click');
    expect(push).toHaveBeenCalledWith('/tasks/TASK-F');
  });

  it('发布按钮：点击弹确认窗（不直接发布），留空发布 = 自动接单', async () => {
    mockedApi.listTasks
      .mockResolvedValueOnce([{ taskId: 'TASK-D', title: '草稿任务', status: 'draft', hasResult: false }])
      .mockResolvedValue([{ taskId: 'TASK-D', title: '草稿任务', status: 'pending', hasResult: false }]);
    mockedApi.publishTask.mockResolvedValue(SAMPLE_TASK as never);
    mockedApi.listEmployees.mockResolvedValue(EMPLOYEES as never);
    const success = vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never);
    const router = makeTestRouter([
      { path: '/tasks', component: TaskCenter },
      { path: '/tasks/:id', component: { template: '<div />' } },
    ]);
    const wrapper = await mountWithRouter(TaskCenter, { router, path: '/tasks' });
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined as never);
    await flushPromises();

    // draft 行有发布按钮（pending 行没有）
    expect(wrapper.find('[data-test="publish-btn"]').exists()).toBe(true);
    await wrapper.find('[data-test="publish-btn"]').trigger('click');
    await flushPromises();
    // 弹窗打开，尚未发布
    expect(wrapper.find('[data-test="publish-confirm"]').exists()).toBe(true);
    expect(mockedApi.publishTask).not.toHaveBeenCalled();

    // 不选员工直接发布 = 自动接单（不调 assignTask）
    await wrapper.find('[data-test="publish-confirm"]').trigger('click');
    await flushPromises();

    expect(mockedApi.assignTask).not.toHaveBeenCalled();
    expect(mockedApi.publishTask).toHaveBeenCalledWith('TASK-D');
    expect(success).toHaveBeenCalledWith('已发布，任务进入自动接单');
    expect(mockedApi.listTasks).toHaveBeenCalledTimes(2); // 发布后刷新列表
    // 发布按钮 @click.stop：不触发行跳转
    expect(push).not.toHaveBeenCalled();
    success.mockRestore();
  });

  it('编排视图入口（2026-09-08 独立页面化）：按钮跳转 /tasks/dag，弹窗形态移除', async () => {
    mockedApi.listTasks.mockResolvedValue([
      { taskId: 'TASK-A', title: '底座任务', status: 'done', hasResult: true },
      { taskId: 'TASK-B', title: '下游任务', status: 'pending', hasResult: false, dependsOn: ['TASK-A'], depsState: 'ready' },
    ] as never);
    const router = makeTestRouter([
      { path: '/tasks', component: TaskCenter },
      { path: '/tasks/dag', component: { template: '<div data-test="dag-stub" />' } },
      { path: '/tasks/:id', component: { template: '<div />' } },
    ]);
    const wrapper = await mountWithRouter(TaskCenter, { router, path: '/tasks' });
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined as never);
    await flushPromises();

    // 检索区「编排视图」按钮 → 路由跳独立页（不再开弹窗）
    expect(wrapper.find('[data-test="dag-btn"]').exists()).toBe(true);
    await wrapper.find('[data-test="dag-btn"]').trigger('click');
    await flushPromises();
    expect(push).toHaveBeenCalledWith('/tasks/dag');

    // 弹窗形态移除：任务中心页内不再渲染 DAG 弹窗
    expect(wrapper.find('[data-test="dag"]').exists()).toBe(false);
    expect(wrapper.findAllComponents({ name: 'ElDialog' }).some((d) => d.props('title') === '任务依赖编排视图')).toBe(false);
  });

  it('无编排入口：不存在 mode-dag 按钮', async () => {
    stubThreeTasks();
    const wrapper = await mountCenter();
    await flushPromises();
    expect(wrapper.find('[data-test="mode-dag"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="mode-list"]').exists()).toBe(false);
  });

  it('失败状态空匹配显示空态与清筛选', async () => {
    stubThreeTasks();
    const wrapper = await mountCenter();
    await flushPromises();
    await wrapper.find('[data-test="status-filter"]').trigger('click');
    await flushPromises();
    await wrapper.findAll('.el-select-dropdown__item')[5]!.trigger('click');
    await wrapper.find('[data-test="search-input"]').setValue('不存在的任务');
    await flushPromises();
    expect(wrapper.text()).toContain('无匹配任务');

    await wrapper.find('[data-test="clear-filter"]').trigger('click');
    await flushPromises();
    expect(rows(wrapper).length).toBe(3);
    expect(wrapper.find('[data-test="clear-filter"]').exists()).toBe(false); // 无筛选时按钮隐藏
  });

  it('关键词检索大小写不敏感（与其他页 matches 口径统一，2026-09-08 收尾）', async () => {
    stubThreeTasks();
    const wrapper = await mountCenter();
    await flushPromises();
    // 小写关键词命中大写 taskId（SkillLibrary/Employees/Channels 等页均 toLowerCase 口径）
    await wrapper.find('[data-test="search-input"]').setValue('task-a');
    expect(rows(wrapper)).toHaveLength(1);
    expect(rows(wrapper)[0]!.text()).toContain('TASK-A');
  });

  it('matches 纯函数：关键词匹配 taskId/标题、状态多选空=全部（defineExpose 供测试）', async () => {
    stubThreeTasks();
    const wrapper = await mountCenter();
    await flushPromises();
    const { matches } = wrapper.vm as unknown as { matches: (t: { taskId: string; title: string; status: string }, kw: string, statuses: string[]) => boolean };
    const t = { taskId: 'TASK-A', title: '登录模块前端重构', status: 'draft' };
    expect(matches(t, '', [])).toBe(true);
    expect(matches(t, 'TASK-A', [])).toBe(true);
    expect(matches(t, '登录模块', [])).toBe(true);
    expect(matches(t, 'TASK-A', ['draft'])).toBe(true);
    expect(matches(t, 'TASK-A', ['failed'])).toBe(false);
    expect(matches(t, 'TASK-B', [])).toBe(false);
    // 大小写不敏感（与其他页检索口径统一）
    expect(matches(t, 'task-a', [])).toBe(true);
    expect(matches(t, '登录模块'.toUpperCase(), [])).toBe(true);
    expect(matches(t, 'task-b', [])).toBe(false);
  });

  it('新建任务按钮：打开双模式创建对话框（老 yaml 直贴入口迁入，见 task-create-dialog.test.ts）', async () => {
    mockedApi.listTasks.mockResolvedValue([]);
    mockedApi.listCapabilities.mockResolvedValue([]);
    const wrapper = await mountCenter();
    await flushPromises();

    expect(wrapper.find('[data-test="mode-yaml"]').exists()).toBe(false); // 入口已迁入对话框
    await wrapper.find('[data-test="create-btn"]').trigger('click');
    await flushPromises();
    // 对话框默认表单模式，切到 yaml 直贴后老入口可用（element-plus attrs 落到内部 input）
    await wrapper.find('[data-test="mode-yaml"] input').setValue(true);
    expect(wrapper.find('[data-test="yaml-input"]').exists()).toBe(true);
  });

  it('编辑草稿（2026-09-06）：draft 行「编辑」打开编辑对话框，pkg→yaml 回填 + 保存走 draft 覆盖', async () => {
    mockedApi.listTasks.mockResolvedValue([
      { taskId: 'TASK-D', title: '草稿任务', status: 'draft', hasResult: false },
    ] as never);
    mockedApi.getTask.mockResolvedValue({
      pkg: {
        taskId: 'TASK-D',
        title: '草稿任务',
        repo: { url: 'http://gitea.inner.bank/admin/dome.git', branch: 'main' },
        tasks: [], // 计划模式包：tasks 为空数组，回填不得输出（后端判 plan/tasks 互斥）
        plan: [
          { id: 't1', title: '克隆仓库', detail: 'clone', verify: 'test -d .git' },
          { id: 't2', kind: 'devops', title: '部署', detail: 'deploy 到测试环境' },
        ],
      },
      status: 'draft',
      hasResult: false,
    } as never);
    mockedApi.listCapabilities.mockResolvedValue([]);
    mockedApi.listEmployees.mockResolvedValue(EMPLOYEES as never);
    const router = makeTestRouter([
      { path: '/tasks', component: TaskCenter },
      { path: '/tasks/:id', component: { template: '<div />' } },
    ]);
    const wrapper = await mountWithRouter(TaskCenter, { router, path: '/tasks' });
    await flushPromises();

    await rows(wrapper)[0]!.find('[data-test="edit-btn"]').trigger('click');
    await flushPromises();

    // 编辑对话框：默认 yaml 模式，回填含计划明细
    expect(wrapper.find('[data-test="task-dialog-edit"]').exists()).toBe(true);
    const yaml = (wrapper.find('[data-test="yaml-input"]').element as HTMLTextAreaElement).value;
    expect(yaml).toContain('taskId: TASK-D');
    expect(yaml).toContain('verify: test -d .git');
    expect(yaml).toContain('kind: devops');
    expect(yaml).not.toContain('tasks:');
    // 空 kind/verify 不输出（t2 无 verify）
    expect(yaml).not.toContain('verify: deploy');

    // 保存仍走 createTask（后端 draft 覆盖），提示按编辑语境
    mockedApi.createTask.mockResolvedValue({ taskId: 'TASK-D', status: 'draft' } as never);
    const success = vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never);
    await wrapper.find('[data-test="submit"]').trigger('click');
    await flushPromises();
    expect(mockedApi.createTask).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith(expect.stringContaining('已更新'));
  });

  it('固化失败展示错误信息', async () => {
    mockedApi.listTasks.mockResolvedValue([]);
    mockedApi.listCapabilities.mockResolvedValue([]);
    mockedApi.createTask.mockRejectedValue(new Error('taskId 缺失'));
    const wrapper = await mountCenter();
    await flushPromises();
    await wrapper.find('[data-test="create-btn"]').trigger('click');
    await flushPromises();
    // 对话框内切 yaml 直贴模式提交
    await wrapper.find('[data-test="mode-yaml"] input').setValue(true);
    await wrapper.find('[data-test="yaml-input"]').setValue('bad');
    await wrapper.find('[data-test="submit"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="error"]').text()).toContain('taskId 缺失');
    // 提交失败对话框保持打开
    expect(wrapper.find('[data-test="yaml-input"]').exists()).toBe(true);
  });
});

describe('TaskCenter 发布确认选员工（2026-09-06：发布时弹窗点名，不选 = 自动接单）', () => {
  function mountCenter() {
    const router = makeTestRouter([
      { path: '/tasks', component: TaskCenter },
      { path: '/tasks/:id', component: { template: '<div data-test="detail-stub" />' } },
    ]);
    return mountWithRouter(TaskCenter, { router, path: '/tasks' });
  }

  it('发布弹窗：选项仅启用员工（排除停用）、label 为 id + 姓名', async () => {
    mockedApi.listTasks.mockResolvedValue([
      { taskId: 'TASK-A', title: '草稿任务', status: 'draft', hasResult: false },
    ] as never);
    mockedApi.listEmployees.mockResolvedValue(EMPLOYEES as never);
    const wrapper = await mountCenter();
    await flushPromises();

    await wrapper.find('[data-test="publish-btn"]').trigger('click');
    await flushPromises();
    // 打开时拉取员工列表，标题带 taskId
    expect(mockedApi.listEmployees).toHaveBeenCalled();
    expect(wrapper.text()).toContain('发布任务 · TASK-A');
    // 下拉仅启用员工（停用 emp-2 被排除）
    await wrapper.find('[data-test="publish-assignee-select"]').trigger('click');
    await flushPromises();
    const opts = wrapper.findAll('[data-test^="publish-assignee-option-"]');
    expect(opts.map((o) => o.text())).toEqual(['emp-1 张后端']);
  });

  it('选中员工发布：先 assignTask 写点名再 publishTask + 提示分派对象 + 刷新', async () => {
    mockedApi.listTasks.mockResolvedValue([
      { taskId: 'TASK-A', title: '草稿任务', status: 'draft', hasResult: false },
    ] as never);
    mockedApi.listEmployees.mockResolvedValue(EMPLOYEES as never);
    mockedApi.assignTask.mockResolvedValue({ pkg: { taskId: 'TASK-A' }, status: 'draft' } as never);
    mockedApi.publishTask.mockResolvedValue(SAMPLE_TASK as never);
    const success = vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never);
    const wrapper = await mountCenter();
    await flushPromises();

    await wrapper.find('[data-test="publish-btn"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="publish-assignee-select"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="publish-assignee-option-emp-1"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="publish-confirm"]').trigger('click');
    await flushPromises();

    // 调用顺序：先点名后发布（点名写 pkg.assignee，publish 转 pending 后调度器点名接单）
    expect(mockedApi.assignTask).toHaveBeenCalledWith('TASK-A', 'emp-1');
    expect(mockedApi.publishTask).toHaveBeenCalledWith('TASK-A');
    const assignOrder = mockedApi.assignTask.mock.invocationCallOrder[0]!;
    const publishOrder = mockedApi.publishTask.mock.invocationCallOrder[0]!;
    expect(assignOrder).toBeLessThan(publishOrder);
    expect(success).toHaveBeenCalledWith('已发布，将分派给 张后端');
    expect(mockedApi.listTasks).toHaveBeenCalledTimes(2); // 发布后刷新列表
    // 弹窗已关（el-dialog 不加 destroy-on-close 时内容仍挂载，断言 modelValue 而非 DOM）
    expect(wrapper.findAllComponents({ name: 'ElDialog' }).some((d) => d.props('modelValue') === true)).toBe(false);
    success.mockRestore();
  });

  it('发布失败：错误经 ElMessage.error 在弹窗层可见（弹窗不关，可重试）', async () => {
    mockedApi.listTasks.mockResolvedValue([
      { taskId: 'TASK-A', title: '草稿任务', status: 'draft', hasResult: false },
    ] as never);
    mockedApi.listEmployees.mockResolvedValue(EMPLOYEES as never);
    mockedApi.publishTask.mockRejectedValue(new Error('任务状态不允许发布'));
    const errMsg = vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never);
    const wrapper = await mountCenter();
    await flushPromises();

    await wrapper.find('[data-test="publish-btn"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="publish-confirm"]').trigger('click');
    await flushPromises();

    expect(errMsg).toHaveBeenCalledWith('任务状态不允许发布');
    // 失败后弹窗仍开着，可改选后重试
    expect(wrapper.findAllComponents({ name: 'ElDialog' }).some((d) => d.props('modelValue') === true)).toBe(true);
    errMsg.mockRestore();
  });
});

describe('TaskDetail 任务详情', () => {
  it('展示任务包字段：分支/文件/验收标准', async () => {
    mockedApi.getTask.mockResolvedValue(SAMPLE_TASK);
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-2026-0912-001' } });
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('登录模块前端重构');
    expect(text).toContain('feature/login-refactor');
    expect(text).toContain('src/views/login/index.vue');
    expect(text).toContain('npm run build 通过');
  });

  it('详情页无接单按钮（2026-09-06 用户确认：分派统一自动，续跑由调度器点名原员工）', async () => {
    mockedApi.getTask.mockResolvedValue(SAMPLE_TASK);
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-2026-0912-001' } });
    await flushPromises();

    expect(wrapper.find('[data-test="claim-btn"]').exists()).toBe(false);
    expect(mockedApi.claimTask).not.toHaveBeenCalled();
  });

  it('已领取的任务不显示接单按钮', async () => {
    mockedApi.getTask.mockResolvedValue({ ...SAMPLE_TASK, status: 'running', claimedBy: 'emp-01' });
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-2026-0912-001' } });
    await flushPromises();
    expect(wrapper.find('[data-test="claim-btn"]').exists()).toBe(false);
  });

  it('计划明细表：draft（未执行、无进度）也能看每步的任务要求/验收命令（2026-09-06 用户反馈）', async () => {
    mockedApi.getTask.mockResolvedValue({
      ...SAMPLE_TASK,
      status: 'draft',
      pkg: {
        ...SAMPLE_TASK.pkg,
        tasks: [],
        plan: [
          { id: 't1', kind: 'devops', title: '切 dev 分支', detail: '基于 main 切出 dev', verify: 'git branch --show-current | grep -x dev' },
          { id: 't2', kind: 'dev', title: '新增页面', detail: '新增 detail.html' },
        ],
      },
    });
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-2026-0912-001' } });
    await flushPromises();

    const table = wrapper.find('[data-test="plan-detail"]');
    expect(table.exists()).toBe(true);
    const text = table.text();
    expect(text).toContain('计划明细（2 步）');
    expect(text).toContain('切 dev 分支');
    expect(text).toContain('基于 main 切出 dev');
    expect(text).toContain('git branch --show-current | grep -x dev');
    // 无 verify 的项提示而非空白
    expect(text).toContain('无（员工申报即通过）');
  });

  it('包级依赖展示：dependsOn 任务以 tag 列出（2026-09-06 用户反馈）', async () => {
    mockedApi.getTask.mockResolvedValue({
      ...SAMPLE_TASK,
      pkg: { ...SAMPLE_TASK.pkg, dependsOn: ['TASK-2026-0911-000', 'TASK-2026-0911-002'] },
    });
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-2026-0912-001' } });
    await flushPromises();

    const dep = wrapper.find('[data-test="depends-on"]');
    expect(dep.exists()).toBe(true);
    expect(dep.text()).toContain('TASK-2026-0911-000');
    expect(dep.text()).toContain('TASK-2026-0911-002');
    expect(dep.text()).toContain('全部完成后才可分派');
  });

  it('无 dependsOn 不渲染包级依赖行', async () => {
    mockedApi.getTask.mockResolvedValue(SAMPLE_TASK);
    const wrapper = mountWithEP(TaskDetail, { props: { taskId: 'TASK-2026-0912-001' } });
    await flushPromises();
    expect(wrapper.find('[data-test="depends-on"]').exists()).toBe(false);
  });
});
