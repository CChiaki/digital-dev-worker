import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createMemoryHistory, createRouter, type RouteRecordRaw } from 'vue-router';

type MountOptions = Parameters<typeof mount>[1];

// element-plus 重构后 el-* 组件依赖全局插件注册——测试 mount 不装插件时
// el-* 被当未知元素渲染（props/事件/具名 slot 全失效）。统一走本 helper。
// options.global.plugins 追加（而非覆盖）默认插件，避免路由等场景漏装 ElementPlus。
export function mountWithEP(comp: Parameters<typeof mount>[0], options?: MountOptions) {
  const plugins = [ElementPlus, ...(options?.global?.plugins ?? [])];
  return mount(comp, {
    ...options,
    global: { ...options?.global, plugins },
  });
}

// 路由化（Task 7）：useRouter/useRoute 组件需挂 router 插件。jsdom 用 memory history，
// 先 push 到初始路径再 mount，保证 onMounted 里的路由读取已就绪。
export function makeTestRouter(routes: RouteRecordRaw[]) {
  return createRouter({ history: createMemoryHistory(), routes });
}

export async function mountWithRouter(
  comp: Parameters<typeof mount>[0],
  options: MountOptions & { router: ReturnType<typeof createRouter>; path?: string },
) {
  const { router, path, ...rest } = options;
  if (path && path !== '/') await router.push(path);
  await router.isReady();
  return mount(comp, {
    ...rest,
    global: { plugins: [ElementPlus, router], ...rest?.global },
  });
}
