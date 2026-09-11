<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Odometer, Tickets, CircleCheck, Avatar, Document, Cpu, SetUp, Bell, Reading, Promotion } from '@element-plus/icons-vue';
import MessageBell from './components/MessageBell.vue';
import TokenGate from './components/TokenGate.vue';
import { useLiveCounts } from './live.js';

const route = useRoute();
const router = useRouter();
// 实时角标（2026-09-10 推送改造）：人工放行待审数 / Skill 待审查数——SSE 推送更新，不轮询
const live = useLiveCounts();
const active = computed(() => {
  // 员工下钻/直播高亮「数字员工」；任务详情高亮「任务中心」
  if (route.path.startsWith('/employees')) return '/employees';
  if (route.path.startsWith('/tasks')) return '/tasks';
  return route.path;
});

// 访问鉴权门（2026-09-11 服务端 auth 段）：API 命中 401 时 api.ts 广播，此处弹录入框
const showTokenGate = ref(false);
const onUnauthorized = (): void => { showTokenGate.value = true; };
onMounted(() => window.addEventListener('ddw:unauthorized', onUnauthorized));
onBeforeUnmount(() => window.removeEventListener('ddw:unauthorized', onUnauthorized));

// Skill 待审查角标可点（2026-09-11 用户需求）：带 ?status=pending 跳 Skill 库，落地即待审查筛选；
// stopPropagation 防止冒泡回 el-menu-item 触发默认路由跳转（会丢 query）
function goPendingSkills(e: MouseEvent): void {
  e.stopPropagation();
  void router.push({ path: '/skills', query: { status: 'pending' } });
}
</script>

<template>
  <el-container class="min-h-screen">
    <el-aside width="220px" class="sticky top-0 h-screen flex flex-col z-[100] shadow-[2px_0_10px_rgba(9,25,60,0.35)]"
      style="background: linear-gradient(180deg, #0c1c3c 0%, #123764 100%)">
      <!-- brand 区：高 70px（布局标准） -->
      <div class="flex items-center gap-3 px-5 h-[70px] shrink-0 whitespace-nowrap">
        <span class="w-9 h-9 rounded-[9px] inline-flex items-center justify-center text-white text-xl shrink-0"
          style="background: linear-gradient(135deg, #2f6bff, #5a8bff); box-shadow: 0 2px 8px rgba(47,107,255,0.5)">
          <el-icon><Cpu /></el-icon>
        </span>
        <span class="flex flex-col leading-[1.25]">
          <strong class="text-white text-[15px] tracking-wider">数字开发分身</strong>
          <small class="text-[#8fa5c9] text-[10px] tracking-[1.5px]">DIGITAL AI ENGINEER</small>
        </span>
      </div>
      <!-- el-menu 保留（EP 交互控件），深色变量在 scoped 保留 -->
      <el-menu :default-active="active" router class="side-menu">
        <el-menu-item index="/"><el-icon><Odometer /></el-icon>首页面板</el-menu-item>
        <el-menu-item index="/tasks"><el-icon><Tickets /></el-icon>任务中心</el-menu-item>
        <el-menu-item index="/employees"><el-icon><Avatar /></el-icon>数字员工</el-menu-item>
        <el-menu-item index="/reviews">
          <el-icon><CircleCheck /></el-icon><span>人工放行</span>
          <el-badge
            v-if="live.checksPending > 0"
            :value="live.checksPending"
            :max="99"
            data-test="menu-checks-badge"
            class="ml-auto menu-badge"
          />
        </el-menu-item>
        <el-menu-item index="/audit"><el-icon><Document /></el-icon>审计台账</el-menu-item>
        <el-menu-item index="/capabilities"><el-icon><SetUp /></el-icon>能力管理</el-menu-item>
        <el-menu-item index="/skills">
          <el-icon><Reading /></el-icon><span>Skill 库</span>
          <el-badge
            v-if="live.skillsPending > 0"
            :value="live.skillsPending"
            :max="99"
            data-test="menu-skills-badge"
            class="ml-auto menu-badge cursor-pointer"
            title="点击查看待审查 Skill"
            @click="goPendingSkills"
          />
        </el-menu-item>
        <el-menu-item index="/channels"><el-icon><Bell /></el-icon>通知渠道</el-menu-item>
        <el-menu-item index="/push-logs"><el-icon><Promotion /></el-icon>推送记录</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <!-- topbar：高 56px（布局标准），吸顶 -->
      <el-header height="56px" class="sticky top-0 z-[99] flex items-center h-14 shadow-[0_2px_10px_rgba(9,25,60,0.2)]"
        style="background: #0f2a52">
        <span class="text-white text-[15px] font-semibold tracking-[2px]">管理控制台</span>
        <MessageBell />
      </el-header>
      <el-main><router-view /></el-main>
    </el-container>
    <TokenGate v-model="showTokenGate" />
  </el-container>
</template>

<style scoped>
/* 侧边菜单：透明底融入渐变，激活项白字 + 主色左条（EP 交互控件，深色变量保留） */
.side-menu {
  flex: 1;
  border-right: none;
  background: transparent;
  --el-menu-bg-color: transparent;
  --el-menu-text-color: #b9c6de;
  --el-menu-hover-bg-color: rgba(255, 255, 255, 0.08);
  --el-menu-active-color: #ffffff;
}
.side-menu :deep(.el-menu-item) { font-size: 14px; letter-spacing: 0.5px; height: 46px; }
.side-menu :deep(.el-menu-item.is-active) { font-weight: 600; background: rgba(47, 107, 255, 0.22); border-right: 3px solid var(--color-brand-600); }
/* 菜单角标（2026-09-10）：数量标记贴右侧，不随文字挤压。
   2026-09-11 三轮反馈定位根因：EP .el-menu-item 自带 line-height: var(--el-menu-item-height)=56px
   （我们只覆盖了 height:46px），角标 wrapper 是 inline-block、sup 改 static 进流后，
   wrapper 行盒被 56px 行高 strut 撑高——用户量到的「角标 56px」即此。
   治本（用户建议）：wrapper 改 flex 脱离行内格式化，高度回落到 sup 实际高度 */
.menu-badge { display: flex; align-items: center; }
.menu-badge :deep(.el-badge__content) { position: static; transform: none; height: 20px; line-height: 1; padding: 0 6px; }
</style>
