import { describe, it, expect, vi } from 'vitest';
import { ModelGateway, DEFAULT_STREAM } from '../src/model/gateway.js';
import type { ModelSpec, RouteConfig } from '../src/types.js';
import type { StreamFn } from '@earendil-works/pi-agent-core';

const spec = (name: string): ModelSpec => ({
  name, baseUrl: 'http://model.local/v1', apiKey: 'k', model: name,
});

const routes: RouteConfig[] = [
  { callType: 'chat', primary: spec('glm-5.3-flash'), fallback: spec('qwen3.8-27b') },
  { callType: 'code', primary: spec('qwen3.8-27b') },
];

describe('ModelGateway', () => {
  it('modelFor 把 ModelSpec 映射为 pi Model（openai-completions）', () => {
    const gw = new ModelGateway(routes);
    const m = gw.modelFor('code');
    expect(m.api).toBe('openai-completions');
    expect(m.id).toBe('qwen3.8-27b');
    expect(m.baseUrl).toBe('http://model.local/v1');
    expect(m.headers?.Authorization).toBe('Bearer k');
  });

  it('未配置的 callType 抛错', () => {
    const gw = new ModelGateway(routes);
    expect(() => gw.modelFor('review')).toThrow('未配置的调用类型: review');
  });

  it('streamFnFor：primary 成功直接返回', async () => {
    const gw = new ModelGateway(routes);
    const primary = (() => 'ok') as unknown as StreamFn;
    const stream = gw.streamFnFor('chat', primary);
    const m = gw.modelFor('chat');
    await expect(stream(m, { systemPrompt: 's', messages: [] } as never)).resolves.toBe('ok');
  });

  it('streamFnFor：primary 失败自动切 fallback 模型重试同一轮', async () => {
    const gw = new ModelGateway(routes);
    const calls: string[] = [];
    const primary = (async () => { calls.push('primary'); throw new Error('超时'); }) as unknown as StreamFn;
    const fallback = (async (m: { id: string }) => {
      calls.push(`fallback:${m.id}`);
      return 'ok';
    }) as unknown as StreamFn;
    const stream = gw.streamFnFor('chat', primary, fallback);
    const m = gw.modelFor('chat');
    await expect(stream(m, { systemPrompt: 's', messages: [] } as never)).resolves.toBe('ok');
    expect(calls).toEqual(['primary', 'fallback:qwen3.8-27b']);
  });

  it('streamFnFor：无 fallback 时向上抛', async () => {
    const gw = new ModelGateway(routes);
    const boom = (async () => { throw new Error('挂了'); }) as unknown as StreamFn;
    const stream = gw.streamFnFor('code', boom);
    const m = gw.modelFor('code');
    await expect(stream(m, { systemPrompt: 's', messages: [] } as never)).rejects.toThrow('挂了');
  });
});

describe('ModelGateway 双协议（2026-09-05）', () => {
  const anthropicRoutes: RouteConfig[] = [
    {
      callType: 'chat',
      primary: { ...spec('glm-5.3-flash'), api: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
    },
  ];

  it('api: anthropic-messages → Model.api 正确、x-api-key 头、reasoning=true', () => {
    const gw = new ModelGateway(anthropicRoutes);
    const m = gw.modelFor('chat');
    expect(m.api).toBe('anthropic-messages');
    expect(m.headers?.['x-api-key']).toBe('k');
    expect(m.headers?.Authorization).toBeUndefined();
    expect(m.reasoning).toBe(true);
  });

  it('缺省不传 api → openai-completions + Bearer 头 + reasoning=false（零回归）', () => {
    const gw = new ModelGateway(routes);
    const m = gw.modelFor('chat');
    expect(m.api).toBe('openai-completions');
    expect(m.headers?.Authorization).toBe('Bearer k');
    expect(m.reasoning).toBe(false);
  });

  it('streamFnFor 缺省流按路由协议分派：anthropic 路由分派 DEFAULT_STREAM["anthropic-messages"]（同一引用）', async () => {
    const gw = new ModelGateway(anthropicRoutes);
    const spy = vi.spyOn(DEFAULT_STREAM, 'anthropic-messages').mockImplementation(async () => 'ok' as never);
    try {
      const fn = gw.streamFnFor('chat');
      // 缺省分派走的是 DEFAULT_STREAM 表项本体（spy 拦截到调用即证明同一引用）
      await expect(fn(gw.modelFor('chat'), { systemPrompt: 's', messages: [] } as never)).resolves.toBe('ok');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0].api).toBe('anthropic-messages');
      expect(spy.mock.calls[0]?.[1]).toMatchObject({ systemPrompt: 's' });
      expect(spy.mock.calls[0]?.[2]?.headers?.['x-api-key']).toBe('k');
    } finally {
      spy.mockRestore();
    }
  });

  it('streamFnFor 缺省流按路由协议分派：openai 路由分派 DEFAULT_STREAM["openai-completions"]（同一引用）', async () => {
    const gw = new ModelGateway(routes);
    const openaiSpy = vi.spyOn(DEFAULT_STREAM, 'openai-completions').mockImplementation(async () => 'ok' as never);
    const anthropicSpy = vi.spyOn(DEFAULT_STREAM, 'anthropic-messages');
    try {
      const fn = gw.streamFnFor('code'); // code 无 fallback
      await expect(fn(gw.modelFor('code'), { systemPrompt: 's', messages: [] } as never)).resolves.toBe('ok');
      expect(openaiSpy).toHaveBeenCalledTimes(1);
      expect(anthropicSpy).not.toHaveBeenCalled();
    } finally {
      openaiSpy.mockRestore();
      anthropicSpy.mockRestore();
    }
  });

  it('跨协议 fallback 缺省分派：主调用选 openai 适配器、fallback 调用选 anthropic 适配器', async () => {
    const crossRoutes: RouteConfig[] = [
      {
        callType: 'chat',
        primary: spec('qwen3.8-27b'),
        fallback: { ...spec('glm-5.3-flash'), api: 'anthropic-messages' },
      },
    ];
    const gw = new ModelGateway(crossRoutes);
    const primary = (async () => { throw new Error('超时'); }) as unknown as StreamFn;
    const openaiSpy = vi.spyOn(DEFAULT_STREAM, 'openai-completions');
    const anthropicSpy = vi.spyOn(DEFAULT_STREAM, 'anthropic-messages').mockImplementation(async () => 'ok' as never);
    try {
      const fn = gw.streamFnFor('chat', primary); // fallback 未显式注入 → 缺省按 fallback 协议选
      await expect(fn(gw.modelFor('chat'), { systemPrompt: 's', messages: [] } as never)).resolves.toBe('ok');
      expect(openaiSpy).not.toHaveBeenCalled(); // 主调用走显式注入的 stream
      expect(anthropicSpy).toHaveBeenCalledTimes(1); // fallback 走 anthropic 适配器
      expect(anthropicSpy.mock.calls[0]?.[0].id).toBe('glm-5.3-flash');
      expect(anthropicSpy.mock.calls[0]?.[0].api).toBe('anthropic-messages');
      // headers 注入：fallback 模型的 x-api-key 通过 options.headers 可达适配器
      expect(anthropicSpy.mock.calls[0]?.[2]?.headers?.['x-api-key']).toBe('k');
    } finally {
      openaiSpy.mockRestore();
      anthropicSpy.mockRestore();
    }
  });

  it('headers 注入：model.headers 进入 options.headers（适配器认证预检只读 options），显式传入优先', async () => {
    const gw = new ModelGateway(anthropicRoutes);
    const seen: Array<Record<string, string> | undefined> = [];
    const probe = (async (_m: unknown, _c: unknown, o: { headers?: Record<string, string> }) => {
      seen.push(o?.headers);
      return 'ok';
    }) as unknown as StreamFn;
    const stream = gw.streamFnFor('chat', probe);
    await stream(gw.modelFor('chat'), { systemPrompt: 's', messages: [] } as never, {
      headers: { 'x-api-key': 'override' },
    } as never);
    expect(seen[0]?.['x-api-key']).toBe('override'); // 显式传入优先
  });

  it('headers 注入：不传 options 时 model.headers 仍注入（openai → Authorization Bearer）', async () => {
    const gw = new ModelGateway(routes);
    const seen: Array<Record<string, string> | undefined> = [];
    const probe = (async (_m: unknown, _c: unknown, o: { headers?: Record<string, string> }) => {
      seen.push(o?.headers);
      return 'ok';
    }) as unknown as StreamFn;
    const stream = gw.streamFnFor('code', probe);
    await stream(gw.modelFor('code'), { systemPrompt: 's', messages: [] } as never);
    expect(seen[0]?.Authorization).toBe('Bearer k');
  });

  it('fallback 自带协议时跨协议 fallback 可用', async () => {
    const crossRoutes: RouteConfig[] = [
      {
        callType: 'chat',
        primary: spec('qwen3.8-27b'),
        fallback: { ...spec('glm-5.3-flash'), api: 'anthropic-messages' },
      },
    ];
    const gw = new ModelGateway(crossRoutes);
    const calls: string[] = [];
    const primary = (async () => { calls.push('primary'); throw new Error('超时'); }) as unknown as StreamFn;
    const fallback = (async (m: { id: string }) => { calls.push(`fallback:${m.id}`); return 'ok'; }) as unknown as StreamFn;
    const stream = gw.streamFnFor('chat', primary, fallback);
    await expect(stream(gw.modelFor('chat'), { systemPrompt: 's', messages: [] } as never)).resolves.toBe('ok');
    expect(calls).toEqual(['primary', 'fallback:glm-5.3-flash']);
  });
});

describe('模型请求超时 + 重试接线（2026-09-11 P0 韧性批）', () => {
  /** 挂起流：只监听 signal abort——无 signal 时永不落定（证明超时布线的唯一判据）；
   *  已 aborted 的 signal 不会再发事件，需前置短路 */
  const hang = (async (_m: unknown, _c: unknown, o: { signal?: AbortSignal }) =>
    new Promise<never>((_, reject) => {
      if (!o.signal) throw new Error('未注入 signal——超时布线缺失');
      const why = (): string => `aborted:${o.signal!.reason instanceof Error ? o.signal!.reason.message : 'timeout'}`;
      if (o.signal.aborted) reject(new Error(why()));
      else o.signal.addEventListener('abort', () => reject(new Error(why())));
    })) as unknown as StreamFn;

  it('每次调用注入 signal（AbortSignal.timeout 挂墙钟）+ maxRetries=1（429/网络错由 SDK 退避重试）', async () => {
    const seen: Array<{ signal?: AbortSignal; maxRetries?: number }> = [];
    const probe = (async (_m: unknown, _c: unknown, o: { signal?: AbortSignal; maxRetries?: number }) => {
      seen.push({ signal: o.signal, maxRetries: o.maxRetries });
      return 'ok';
    }) as unknown as StreamFn;
    const gw = new ModelGateway(routes);
    const stream = gw.streamFnFor('code', probe);
    await expect(stream(gw.modelFor('code'), { systemPrompt: 's', messages: [] } as never)).resolves.toBe('ok');
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.signal!.aborted).toBe(false); // 正常调用到点前不打扰
    expect(seen[0]!.maxRetries).toBe(1);
  });

  it('路由 timeoutMs 生效：primary 挂起 → 到点 abort 抛错（无 fallback 向上传播）', async () => {
    const timedRoutes: RouteConfig[] = [
      { callType: 'code', primary: { ...spec('glm-x'), timeoutMs: 80 } },
    ];
    const gw = new ModelGateway(timedRoutes);
    const stream = gw.streamFnFor('code', hang);
    const t0 = Date.now();
    await expect(stream(gw.modelFor('code'), { systemPrompt: 's', messages: [] } as never))
      .rejects.toThrow(/aborted:/);
    expect(Date.now() - t0).toBeLessThan(5_000); // 走的是 80ms 路由超时，不是 120s 缺省
  });

  it('primary 超时挂起 → fallback 接管返回（挂死模型不再拖死整轮）', async () => {
    const timedRoutes: RouteConfig[] = [
      {
        callType: 'chat',
        primary: { ...spec('glm-x'), timeoutMs: 80 },
        fallback: { ...spec('qwen-fb'), timeoutMs: 80 },
      },
    ];
    const gw = new ModelGateway(timedRoutes);
    const fallback = (async () => 'ok-fb') as unknown as StreamFn;
    const stream = gw.streamFnFor('chat', hang, fallback);
    await expect(stream(gw.modelFor('chat'), { systemPrompt: 's', messages: [] } as never)).resolves.toBe('ok-fb');
  });

  it('调用方 signal 合并（AbortSignal.any）：外部 abort 同样中止请求', async () => {
    const timedRoutes: RouteConfig[] = [
      { callType: 'code', primary: { ...spec('glm-x'), timeoutMs: 60_000 } }, // 缺省远不触发，只验外部 signal
    ];
    const gw = new ModelGateway(timedRoutes);
    const stream = gw.streamFnFor('code', hang);
    const ctl = new AbortController();
    ctl.abort(new Error('上游取消'));
    await expect(
      stream(gw.modelFor('code'), { systemPrompt: 's', messages: [] } as never, { signal: ctl.signal } as never),
    ).rejects.toThrow(/aborted:上游取消|aborted:/);
  });
});
