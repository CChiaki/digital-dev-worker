import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * 轻量分级日志单测（2026-09-11 P2 产品批）：DDW_LOG_LEVEL 级别过滤 + 统一 [ddw:tag] 前缀 +
 * error/warn 走 stderr / info-debug 走 stdout。模块在 import 时定格级别——vi.resetModules
 * + 改环境变量 + 动态 import 验证不同级别。
 */

afterEach(() => {
  delete process.env.DDW_LOG_LEVEL;
  vi.restoreAllMocks();
  vi.resetModules();
});

async function freshLogger(level?: string): Promise<typeof import('../src/team/logger.js')> {
  vi.resetModules();
  if (level === undefined) delete process.env.DDW_LOG_LEVEL;
  else process.env.DDW_LOG_LEVEL = level;
  return import('../src/team/logger.js');
}

describe('logger（轻量分级日志，2026-09-11 P2 产品批）', () => {
  it('缺省 info：debug 静默丢弃；info/warn/error 输出带统一 [ddw:tag] 前缀', async () => {
    const { log } = await freshLogger();
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    log.debug('scheduler', 'tick 细节', { a: 1 });
    expect(stdout).not.toHaveBeenCalled();

    log.info('retention', '磁盘清扫：3 个目录');
    expect(stdout).toHaveBeenCalledWith('[ddw:retention] 磁盘清扫：3 个目录');

    log.warn('store', '事件重复落库已忽略');
    expect(warn).toHaveBeenCalledWith('[ddw:store] 事件重复落库已忽略');

    log.error('runtime', 'tick 失败:', 'boom');
    expect(stderr).toHaveBeenCalledWith('[ddw:runtime] tick 失败:', 'boom');
  });

  it('DDW_LOG_LEVEL=debug：debug 级放行；DDW_LOG_LEVEL=error：info 静默', async () => {
    const { log: log1 } = await freshLogger('debug');
    const stdout1 = vi.spyOn(console, 'log').mockImplementation(() => {});
    log1.debug('scheduler', '细节');
    expect(stdout1).toHaveBeenCalledWith('[ddw:scheduler] 细节');
    vi.restoreAllMocks();

    const { log: log2 } = await freshLogger('error');
    const stdout2 = vi.spyOn(console, 'log').mockImplementation(() => {});
    log2.info('retention', '清扫');
    expect(stdout2).not.toHaveBeenCalled();
  });

  it('errLine：Error 压单行（多行 stack 只留首行），非 Error 字符串化', async () => {
    const { errLine } = await freshLogger();
    expect(errLine(new Error('第一行\n第二行堆栈'))).toBe('第一行');
    expect(errLine('纯字符串')).toBe('纯字符串');
    expect(errLine({ weird: true })).toBe(String({ weird: true }));
  });
});
