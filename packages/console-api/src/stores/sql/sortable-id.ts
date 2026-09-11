/**
 * 可排序 id（供 `ORDER BY created_at DESC, id DESC` 双键排序的「最新在前」语义）：
 * 时间戳前缀 + 进程内单调序列——同毫秒插入也保序。随机 UUID 做次序键时同毫秒平手，
 * 顺序随 UUID 随机抖动（2026-09-10 live-push 全量跑偶发红的根因）。
 */
let seq = 0;

export function sortableId(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${String(seq).padStart(6, '0')}`;
}
