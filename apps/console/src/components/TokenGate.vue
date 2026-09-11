<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';

/**
 * 访问鉴权门（2026-09-11 服务端 auth 段启用后）：任何 API 命中 401（api.ts 广播
 * 'ddw:unauthorized'）时弹出，录入令牌存 localStorage（ddw-token）并整页刷新——
 * 刷新后全部请求与 SSE 订阅都带新 token 重放。服务端未启用鉴权时永远不出现（零干扰）。
 */
const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();
const token = ref('');

const save = (): void => {
  const t = token.value.trim();
  if (!t) {
    ElMessage.warning('请输入访问令牌');
    return;
  }
  try {
    localStorage.setItem('ddw-token', t);
  } catch {
    /* localStorage 不可用（隐私模式等）——仍刷新走服务端 401 循环，用户可换浏览器 */
  }
  emit('update:modelValue', false);
  window.location.reload();
};
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    title="访问鉴权"
    width="440px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
    data-test="token-gate"
  >
    <p class="text-sm text-gray-500 mb-2">
      服务端已启用 API 鉴权，请输入访问令牌（由管理员签发分配，一般是 <code>ddw-</code> 开头的字符串）。
    </p>
    <!-- 明文/密文混淆踩坑（2026-09-11 实测）：管理员容易把配置文件里 enc:v1: 开头的密文当令牌分发，
         密文恒 401 弹窗不停——此处显式提示两者区别 -->
    <p class="text-[12px] text-orange-500 mb-3">
      请输入明文令牌（<code>ddw-</code> 开头），不是配置文件里 <code>enc:v1:</code> 开头的密文——密文录入恒提示需要令牌。
    </p>
    <el-input
      v-model="token"
      type="password"
      show-password
      placeholder="API 访问令牌"
      data-test="token-gate-input"
      @keyup.enter="save"
    />
    <template #footer>
      <el-button type="primary" data-test="token-gate-save" @click="save">保存并刷新</el-button>
    </template>
  </el-dialog>
</template>
