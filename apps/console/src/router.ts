import { createRouter, createWebHistory } from 'vue-router';
import Dashboard from './views/Dashboard.vue';
import TaskCenter from './views/TaskCenter.vue';
import TaskDetail from './views/TaskDetail.vue';
import TaskDagView from './views/TaskDagView.vue';
import Employees from './views/Employees.vue';
import EmployeeDetail from './views/EmployeeDetail.vue';
import EmployeeLive from './views/EmployeeLive.vue';
import CheckReview from './views/CheckReview.vue';
import AuditLog from './views/AuditLog.vue';
import Capabilities from './views/Capabilities.vue';
import Channels from './views/Channels.vue';
import PushLogs from './views/PushLogs.vue';
import SkillLibrary from './views/SkillLibrary.vue';

// 管理台路由表（Task 7 骨架）：Dashboard/Employees/EmployeeDetail/Channels 为占位页，Task 8/10 填实
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/tasks', name: 'tasks', component: TaskCenter },
    // 编排视图独立页（2026-09-08）：vue-router 静态段打分天然优先于 :id，注册顺序仅为可读性
    { path: '/tasks/dag', name: 'task-dag', component: TaskDagView },
    { path: '/tasks/:id', name: 'task-detail', component: TaskDetail, props: (r) => ({ taskId: r.params.id as string }) },
    { path: '/employees', name: 'employees', component: Employees },
    { path: '/employees/:id', name: 'employee-detail', component: EmployeeDetail, props: (r) => ({ employeeId: r.params.id as string }) },
    { path: '/employees/:id/live', name: 'employee-live', component: EmployeeLive, props: (r) => ({ employeeId: r.params.id as string }) },
    { path: '/reviews', name: 'reviews', component: CheckReview },
    { path: '/audit', name: 'audit', component: AuditLog },
    { path: '/capabilities', name: 'capabilities', component: Capabilities },
    { path: '/skills', name: 'skills', component: SkillLibrary },
    { path: '/channels', name: 'channels', component: Channels },
    // 推送留痕（2026-09-10 用户需求）：消息 × 渠道推送记录（sent/failed + 燕讯流水号）
    { path: '/push-logs', name: 'push-logs', component: PushLogs },
  ],
});
export default router;
