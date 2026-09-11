/**
 * 轻量分级日志（2026-09-11 P2 产品批）：
 * 内网单机部署不引日志框架——统一入口 + DDW_LOG_LEVEL 环境变量控制级别，
 * 输出格式 `[ddw:模块] 消息`，级别不够静默丢弃。debug 缺省关（生产噪音控制），
 * info 为缺省；DDW_LOG_LEVEL=debug 时模块级细节（清扫明细/调度决策）全量可见。
 *
 * 用法：log.info('scheduler', '任务完成', { taskId })
 * 替代散落的 console.log/error + 手写前缀——原各模块前缀（[runtime]/[audit] 等）收编为 tag。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 当前生效级别（进程启动时定格一次——运行中改环境变量不生效，重启生效，运维心智简单） */
const activeLevel: LogLevel = (() => {
  const raw = (process.env.DDW_LOG_LEVEL ?? '').trim().toLowerCase();
  return raw in LEVEL_WEIGHT ? (raw as LogLevel) : 'info';
})();

function enabled(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[activeLevel];
}

function emit(level: LogLevel, tag: string, msg: string, args?: unknown[]): void {
  if (!enabled(level)) return;
  const line = `[ddw:${tag}] ${msg}`;
  // 对应 console 原生通道（warn→console.warn、error→console.error 走 stderr，pm2/systemd 分流惯例）
  if (level === 'error') console.error(line, ...(args ?? []));
  else if (level === 'warn') console.warn(line, ...(args ?? []));
  else console.log(line, ...(args ?? []));
}

export const log = {
  debug: (tag: string, msg: string, ...args: unknown[]) => emit('debug', tag, msg, args),
  info: (tag: string, msg: string, ...args: unknown[]) => emit('info', tag, msg, args),
  warn: (tag: string, msg: string, ...args: unknown[]) => emit('warn', tag, msg, args),
  error: (tag: string, msg: string, ...args: unknown[]) => emit('error', tag, msg, args),
  /** 生效级别（doctor 巡检/启动日志用） */
  level: (): LogLevel => activeLevel,
};

/** 任意错误压成单行消息（多行 stack 只留首行——审计日志/推送场景一行一条） */
export function errLine(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0]! : String(e);
}
