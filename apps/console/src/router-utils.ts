import type { Router } from 'vue-router';

/** 返回按钮兜底：直链/刷新进入时 history 无本站上一页，back 会退出站点 → 回首页 */
export function goBackOrHome(router: Router): void {
  if (window.history.state?.back) router.back();
  else void router.push('/');
}
