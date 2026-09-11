import type { EventStore } from '../stores/types.js';
import type { IntegrityReport } from '../stores/hash-chain.js';
import { log, errLine } from './logger.js';

/** 最近一次完整性校验结果（GET /api/audit 附带 + 前端徽标数据源） */
export interface IntegrityStatus {
  ok: boolean;
  /** 校验完成时间戳 */
  at: number;
  /** 参与重算的事件条数 */
  total: number;
  /** 首个断点事件 id（ok=false 时） */
  brokenAt?: string;
}

/** IntegrityReport → 驻内存状态视图（字段收敛，不透出内部结构） */
export function toStatus(r: IntegrityReport): IntegrityStatus {
  return {
    ok: r.ok,
    at: Date.now(),
    total: r.total,
    ...(r.brokenAt ? { brokenAt: r.brokenAt } : {}),
  };
}

/**
 * 审计链完整性定时校验（2026-09-11 P1 治理批）：
 * 此前 verifyIntegrity 只有手动 ?integrity=1 和 doctor CLI 两个触发口——篡改/落盘损坏的
 * 无感知窗口无限长。监控器补「启动 + 每日」定时全链重算，结果驻内存：
 * - GET /api/audit 附带最近结果（零成本读内存，前端徽标常驻）；
 * - POST /api/audit/verify 手动「立即校验」走同一 verifyNow（结果同样驻内存）；
 * - 失败回调 onFail 告警（server 侧群发通知渠道）。
 * EventStore 无 verifyIntegrity 能力（测试桩）时 start() 空转——last 恒空，API 不附带字段。
 */
export class IntegrityMonitor {
  private lastResult?: IntegrityStatus;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly events: EventStore,
    private readonly onFail?: (s: IntegrityStatus) => void | Promise<void>,
    private readonly intervalMs = 86_400_000,
  ) {}

  /** 立即校验一轮（启动定时 / 手动按钮共用）：更新驻内存结果；失败触发告警回调 */
  async verifyNow(): Promise<IntegrityStatus> {
    if (!this.events.verifyIntegrity) {
      throw new Error('当前存储实现不支持完整性校验');
    }
    const s = toStatus(await this.events.verifyIntegrity());
    this.lastResult = s;
    if (s.ok) {
      log.info('audit', `审计链完整性校验通过：${s.total} 条`);
    } else {
      // 失败双通道留痕：进程日志 + onFail 告警（渠道推送由 server 侧接线）
      log.error('audit', `审计链完整性校验失败：共 ${s.total} 条，首断点事件 ${s.brokenAt ?? '未知'}`);
      await this.onFail?.(s);
    }
    return s;
  }

  /** 最近一次结果（未校验过 = undefined，API 不附带字段） */
  last(): IntegrityStatus | undefined {
    return this.lastResult;
  }

  /** 启动即校验一轮 + 每日定时（幂等；无 verifyIntegrity 能力空转） */
  start(): void {
    if (this.timer || !this.events.verifyIntegrity) return;
    void this.verifyNow().catch((e) => log.error('audit', '完整性校验执行失败:', errLine(e)));
    this.timer = setInterval(() => {
      void this.verifyNow().catch((e) => log.error('audit', '完整性校验执行失败:', errLine(e)));
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
