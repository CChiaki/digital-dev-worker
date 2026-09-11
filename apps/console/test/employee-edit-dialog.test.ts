import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
// ElMessage 打桩：避免真实弹窗污染 jsdom（对齐 employees.test.ts 模式）
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  };
});
import { ElMessage } from 'element-plus';
import EmployeeEditDialog from '../src/components/EmployeeEditDialog.vue';
import { api } from '../src/api.js';
import { mountWithEP } from './mount-helper.js';

vi.mock('../src/api.js', () => ({
  api: {
    listCapabilities: vi.fn(),
    listSkillCategories: vi.fn(),
    createEmployee: vi.fn(),
    updateEmployee: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);
const mockedMsg = vi.mocked(ElMessage, true);

// 岗位清单 = 分类表（2026-09-07 岗位即技能库）：选项文本与提交值均为分类名（roles 存岗位名字符串数组）
const ROLES = [
  { id: 'backend', name: '后端开发' },
  { id: 'frontend', name: '前端开发' },
  { id: 'qa', name: '测试' },
];

function mountDialog() {
  return mountWithEP(EmployeeEditDialog, { props: { modelValue: true, employee: null } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.listCapabilities.mockResolvedValue([]);
  mockedApi.listSkillCategories.mockResolvedValue(ROLES as never);
  mockedApi.createEmployee.mockResolvedValue({ id: 'emp-03' } as never);
});

describe('EmployeeEditDialog 岗位多选（2026-09-07 员工多岗位）', () => {
  it('岗位为多选下拉：可同时选两岗提交 roles 数组，无单值 role 键', async () => {
    const wrapper = mountDialog();
    await flushPromises();

    // 数据源来自分类表接口（打开对话框即拉取岗位清单）
    expect(mockedApi.listSkillCategories).toHaveBeenCalled();

    // 断言1：d-role 是 select，选项含「后端开发」（选项文本 = 分类名）
    const roleSel = wrapper.find('[data-test="d-role"]');
    expect(roleSel.find('.el-select__wrapper').exists()).toBe(true);
    await roleSel.trigger('click');
    await flushPromises();
    const options = wrapper.findAll('.el-select-dropdown__item');
    expect(options.map((o) => o.text())).toContain('后端开发');

    // 断言2：技能标签输入与技能分类多选已整体移除
    expect(document.querySelector('[data-test="d-skills"]')).toBeNull();
    expect(document.querySelector('[data-test="d-skill-cats"]')).toBeNull();

    // 断言3：可同时选「后端开发」「前端开发」两岗（multiple）
    await options.find((o) => o.text() === '后端开发')!.trigger('click');
    await flushPromises();
    const options2 = wrapper.findAll('.el-select-dropdown__item');
    await options2.find((o) => o.text() === '前端开发')!.trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();

    expect(mockedApi.createEmployee).toHaveBeenCalledTimes(1);
    const payload = mockedApi.createEmployee.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.roles).toEqual(['后端开发', '前端开发']);
    expect(payload).not.toHaveProperty('role'); // 单值 role 键退役
    expect(payload).not.toHaveProperty('skills');
    expect(payload).not.toHaveProperty('skillCategories');
    expect(mockedMsg.success).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('未选岗位点保存：表单校验拦截（至少选择一个岗位），createEmployee 不被调用', async () => {
    const wrapper = mountDialog();
    await flushPromises();

    // 不选任何岗位，直接点「登记」
    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();

    // 校验失败：不发起请求、不弹成功提示
    expect(mockedApi.createEmployee).not.toHaveBeenCalled();
    expect(mockedApi.updateEmployee).not.toHaveBeenCalled();
    expect(mockedMsg.success).not.toHaveBeenCalled();
    // 表单项内联红字提示「至少选择一个岗位」（el-form-item 错误文案经 refDebounced 100ms 防抖后才渲染）
    await new Promise((resolve) => setTimeout(resolve, 150));
    await flushPromises();
    const error = wrapper.find('.el-form-item__error');
    expect(error.exists()).toBe(true);
    expect(error.text()).toBe('至少选择一个岗位');
    wrapper.unmount();
  });

  it('盯梢等级三级放权说明文案在场（2026-09-11 等级驱动）', async () => {
    const wrapper = mountWithEP(EmployeeEditDialog, {
      props: {
        modelValue: true,
        employee: {
          id: 'emp-01', name: '小数', roles: ['后端开发'], capabilities: ['dev'],
          enabled: true, supervision: 'shadow' as const, busy: false, runningTasks: [],
        },
      },
    });
    await flushPromises();
    const hint = wrapper.find('[data-test="d-supervision-hint"]');
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain('盯梢期');
    expect(hint.text()).toContain('辅助期');
    expect(hint.text()).toContain('信任期');
    expect(hint.text()).toContain('高危命令仍全局拦截');
    wrapper.unmount();
  });

  it('编辑模式：roles 数组回显既有岗位，保存 payload 不再携带 role/skills/skillCategories', async () => {
    mockedApi.updateEmployee.mockResolvedValue({ id: 'emp-01' } as never);
    const wrapper = mountWithEP(EmployeeEditDialog, {
      props: {
        modelValue: true,
        employee: {
          id: 'emp-01', name: '小数', roles: ['后端开发', '测试'], capabilities: ['dev'],
          enabled: true, supervision: 'shadow' as const, busy: false, runningTasks: [],
        },
      },
    });
    await flushPromises();

    await wrapper.find('[data-test="save-btn"]').trigger('click');
    await flushPromises();

    expect(mockedApi.updateEmployee).toHaveBeenCalledWith(
      'emp-01',
      expect.objectContaining({ id: 'emp-01', roles: ['后端开发', '测试'], capabilities: ['dev'] }),
    );
    const payload = mockedApi.updateEmployee.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('role');
    expect(payload).not.toHaveProperty('skills');
    expect(payload).not.toHaveProperty('skillCategories');
    wrapper.unmount();
  });
});
