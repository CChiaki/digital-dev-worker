import { ref } from 'vue';
import { api, type EmployeeRecordView } from './api.js';

/** 全站共享的员工 id→姓名 映射（2026-09-06）：相关页面加载时拉一次员工名册；
 *  拉取失败回退空映射（employeeName 回退显示原 id），不阻塞页面渲染 */
export const employeeNameMap = ref(new Map<string, string>());

export async function ensureEmployeeNames(): Promise<void> {
  if (employeeNameMap.value.size > 0) return; // 已有映射：模块级缓存不重复拉取（失败留空映射，下次进入页面重试）
  try {
    const list = ((await api.listEmployees()) ?? []) as EmployeeRecordView[];
    employeeNameMap.value = new Map(list.map((e) => [e.id, e.name]));
  } catch {
    employeeNameMap.value = new Map(); // 失败静默：显示原 id，刷新页面重置
  }
}

/** id → 姓名；映射无该 id（或入参空）回退显示原 id，不得显示空白 */
export function employeeName(id: string | null | undefined): string {
  return (id && employeeNameMap.value.get(id)) || id || '';
}
