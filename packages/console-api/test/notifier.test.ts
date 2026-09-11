import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildChannelPayload,
  pushToChannel,
  sendTestMessage,
  validateChannelDef,
  FileChannelStore,
  encryptChannelSecrets,
  localDateTimeString,
  type NotificationChannelDef,
  type YanxunConfig,
} from '../src/team/notifier.js';
import { encryptSecret } from '../src/team/credentials.js';
import type { MessageRecord } from '../src/team/messages.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddw-notifier-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

/** 测试用消息（MessageRecord 形态；推送只读 type/title/summary/taskId） */
const msg = (taskId = 't'): MessageRecord => ({
  id: 'm1', type: 'task_failed', title: `任务 ${taskId} 执行失败`,
  summary: 'verify 挂了', taskId, createdAt: Date.now(),
});

describe('通知渠道（2026-09-06）', () => {
  it('buildChannelPayload：dingtalk text 格式 + secret 加签 URL（timestamp+sign 参数）', () => {
    const def: NotificationChannelDef = {
      id: 'd1', type: 'dingtalk', name: '钉钉',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=x', secret: 'SECxxx', enabled: true,
    };
    const { url, body } = buildChannelPayload(def, msg(), 'http://c.local/tasks/t');
    expect(body.msgtype).toBe('text');
    expect((body.text as { content: string }).content).toContain('任务 t 执行失败');
    expect((body.text as { content: string }).content).toContain('verify 挂了');
    expect((body.text as { content: string }).content).toContain('http://c.local/tasks/t');
    expect(url).toContain('&timestamp=');
    expect(url).toContain('&sign=');
  });

  it('wecom markdown 格式；webhook 原样 JSON（含 type/title/summary/taskId/consoleUrl）', () => {
    const wecom: NotificationChannelDef = { id: 'w1', type: 'wecom', name: '企微', webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', enabled: true };
    const w = buildChannelPayload(wecom, msg('t2'), 'http://c.local');
    expect(w.body.msgtype).toBe('markdown');
    expect((w.body.markdown as { content: string }).content).toContain('**任务 t2 执行失败**');
    expect((w.body.markdown as { content: string }).content).toContain('[直达](http://c.local/tasks/t2)');

    const hook: NotificationChannelDef = { id: 'h1', type: 'webhook', name: '通用', webhookUrl: 'https://hook.local/notify', enabled: true };
    const j = buildChannelPayload(hook, msg('t3'), 'http://c.local');
    expect(j.url).toBe('https://hook.local/notify');
    expect(j.body).toMatchObject({
      type: 'task_failed', title: '任务 t3 执行失败', summary: 'verify 挂了',
      taskId: 't3', consoleUrl: 'http://c.local',
    });

    // consoleUrl 缺省：通用 JSON 不带 consoleUrl 字段，dingtalk/wecom 不拼直达链接
    const noLink = buildChannelPayload(hook, msg('t4'));
    expect('consoleUrl' in noLink.body).toBe(false);
    const noLinkDing = buildChannelPayload({ ...hook, type: 'dingtalk' }, msg('t4'));
    expect((noLinkDing.body.text as { content: string }).content).not.toContain('直达');
  });

  it('无 secret 的 dingtalk 不加签（URL 原样）', () => {
    const def: NotificationChannelDef = { id: 'd2', type: 'dingtalk', name: '钉钉无密', webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=y', enabled: true };
    expect(buildChannelPayload(def, msg()).url).toBe('https://oapi.dingtalk.com/robot/send?access_token=y');
  });

  it('validateChannelDef：非法形状报可读错误', () => {
    expect(() => validateChannelDef({ id: '', type: 'dingtalk', name: 'n', webhookUrl: 'https://x', enabled: true })).toThrow('id');
    expect(() => validateChannelDef({ id: 'a', type: 'sms' as never, name: 'n', webhookUrl: 'https://x', enabled: true })).toThrow('type');
    expect(() => validateChannelDef({ id: 'a', type: 'wecom', name: ' ', webhookUrl: 'https://x', enabled: true })).toThrow('name');
    expect(() => validateChannelDef({ id: 'a', type: 'wecom', name: 'n', webhookUrl: 'ftp://x', enabled: true })).toThrow('webhookUrl');
    expect(() => validateChannelDef({ id: 'a', type: 'wecom', name: 'n', webhookUrl: 'https://x', enabled: 'yes' as never })).toThrow('enabled');
  });

  it('FileChannelStore：upsert/list/remove（模式照抄既有 store）', async () => {
    const filePath = join(root, 'notification-channels.json');
    const store = new FileChannelStore(filePath);
    expect(await store.list()).toEqual([]); // 文件不存在 → 空表

    const d1: NotificationChannelDef = { id: 'd1', type: 'dingtalk', name: '钉钉', webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=x', enabled: true };
    const w1: NotificationChannelDef = { id: 'w1', type: 'wecom', name: '企微', webhookUrl: 'https://qyapi.weixin.qq.com/x', enabled: false };
    await store.upsert(d1);
    await store.upsert(w1);
    expect((await store.list()).map((c) => c.id)).toEqual(['d1', 'w1']);

    // upsert 覆盖同 id
    await store.upsert({ ...d1, enabled: false });
    expect((await store.list()).find((c) => c.id === 'd1')?.enabled).toBe(false);

    // remove：存在 true / 不存在 false；新实例可读回（落盘）
    expect(await store.remove('w1')).toBe(true);
    expect(await store.remove('w1')).toBe(false);
    expect((await new FileChannelStore(filePath).list()).map((c) => c.id)).toEqual(['d1']);

    // 损坏文件原样上抛（不得静默清空）
    await writeFile(filePath, 'not json', 'utf8');
    const broken = new FileChannelStore(filePath);
    await expect(broken.list()).rejects.toThrow();
  });

  it('pushToChannel：非 2xx 抛错（fetch stub）；2xx 静默', async () => {
    const def: NotificationChannelDef = { id: 'h1', type: 'webhook', name: '通用', webhookUrl: 'https://hook.local/notify', enabled: true };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return { ok: false, status: 500 } as Response;
    });
    await expect(pushToChannel(def, msg('t5'), 'http://c.local')).rejects.toThrow(/渠道 通用 推送失败: HTTP 500/);
    expect(calls[0]!.url).toBe('https://hook.local/notify');
    expect((calls[0]!.init.body as string)).toContain('"taskId":"t5"');

    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
    await expect(pushToChannel(def, msg('t5'))).resolves.toEqual({}); // 非燕讯渠道无 seqNo
  });

  it('sendTestMessage：推送测试文案（title 带 [测试]）', async () => {
    const def: NotificationChannelDef = { id: 'w1', type: 'wecom', name: '企微', webhookUrl: 'https://qyapi.weixin.qq.com/x', enabled: true };
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return { ok: true, status: 200 } as Response;
    });
    await expect(sendTestMessage(def, 'http://c.local')).resolves.toEqual({});
    expect(bodies[0]).toMatchObject({ msgtype: 'markdown' });
    expect(JSON.stringify(bodies[0])).toContain('[测试] 通知渠道 企微');
  });
});

describe('燕讯渠道（2026-09-10）', () => {
  const yx: YanxunConfig = {
    apiUrl: 'http://170.200.34.70:8199/api/message/sendRobotText',
    head: {
      serviceCode: '50022000009', serviceScene: '11', lglBrId: '001',
      consumerId: '0251', orgConsumerId: '0251', channelTyp: 'CH0540', filFlg: '0',
    },
  };
  const yxDef: NotificationChannelDef = { id: 'y1', type: 'yanxun', name: '燕讯', webhookUrl: '', token: 'tok-abc', enabled: true };

  it('payload：requestHead 固定参数 + 动态日期/时间/流水号；requestBody token/appCode=员工id/markdown/isAtAll', () => {
    const { url, body, yanxunSeqNo } = buildChannelPayload(yxDef, { ...msg(), employeeId: 'emp-01' }, 'http://c.local', yx);
    expect(url).toBe(yx.apiUrl);

    const head = body.requestHead as Record<string, string>;
    expect(head).toMatchObject({
      serviceCode: '50022000009', serviceScene: '11', lglBrId: '001',
      consumerId: '0251', orgConsumerId: '0251', channelTyp: 'CH0540', filFlg: '0',
    });
    expect(head.tranDate).toMatch(/^\d{8}$/);                      // YYYYMMDD
    expect(head.tranTime).toMatch(/^\d{6}$/);                      // HHMMSS
    // 流水号 R0251 + tranDate + tranTime + 16 位随机 hex；两个流水号独立生成
    const seq = `R0251${head.tranDate}${head.tranTime}`;
    expect(head.consumerSeqNo).toMatch(new RegExp(`^${seq}[0-9a-f]{16}$`));
    expect(head.orgConsumerSeqNo).toMatch(new RegExp(`^${seq}[0-9a-f]{16}$`));
    expect(head.consumerSeqNo).not.toBe(head.orgConsumerSeqNo);
    // 返回值携带 seqNo（推送留痕用）：即报文的 consumerSeqNo
    expect(yanxunSeqNo).toBe(head.consumerSeqNo);

    const rb = body.requestBody as Record<string, unknown>;
    expect(rb.token).toBe('tok-abc');
    expect(rb.appCode).toBe('emp-01');                             // 员工 id
    expect(rb.isAtAll).toBe('0');                                  // 缺省 '0'
    // 纯文本 content（2026-09-11 实测燕讯不渲染 markdown）：标题 + 要素行 + 摘要 + 直达，无 markdown 符号
    expect(rb.content).toContain('任务 t 执行失败');
    expect(rb.content).toContain('verify 挂了');
    expect(rb.content).toContain('直达: http://c.local/tasks/t');
    expect(rb.content).not.toContain('**');
    expect(rb.content).not.toContain('[');
  });

  it('appCode 无员工回退 consumerId；isAtAll 全局配置 true → 报文 1；无直达链接不拼', () => {
    const noEmp = buildChannelPayload(yxDef, msg(), undefined, yx);
    expect((noEmp.body.requestBody as Record<string, unknown>).appCode).toBe('0251');
    expect((noEmp.body.requestBody as Record<string, string>).content).not.toContain('[直达]');

    const atAll = buildChannelPayload(yxDef, { ...msg(), employeeId: 'e1' }, undefined, { ...yx, isAtAll: true });
    expect((atAll.body.requestBody as Record<string, unknown>).isAtAll).toBe('1');
  });

  it('未传 yanxun 配置 → 可读错误（提示 runtime yaml）', () => {
    expect(() => buildChannelPayload(yxDef, msg())).toThrow(/yanxun 段/);
  });

  it('validateChannelDef：yanxun 必填 token（不校验 webhookUrl）；type 枚举含 yanxun', () => {
    expect(() => validateChannelDef({ id: 'y', type: 'yanxun', name: 'n', webhookUrl: '', enabled: true })).toThrow('access_token');
    expect(() => validateChannelDef(yxDef)).not.toThrow();
    expect(() => validateChannelDef({ id: 'a', type: 'sms' as never, name: 'n', webhookUrl: 'https://x', enabled: true })).toThrow('yanxun');
  });

  it('pushToChannel：燕讯 HTTP 200 业务失败（returnStatus=F）抛 returnCode/returnMsg', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      calls.push(`${url}|${init!.body as string}`);
      return {
        ok: true, status: 200,
        json: async () => ({ responseHead: { returnStatus: 'F', ret: [{ returnCode: '999992', returnMsg: '错误描述:ip 不在白名单中' }] } }),
      } as unknown as Response;
    });
    await expect(pushToChannel(yxDef, { ...msg(), employeeId: 'emp-01' }, 'http://c.local', 10_000, yx))
      .rejects.toThrow(/999992.*ip 不在白名单/);
    const [url, body] = calls[0]!.split('|');
    expect(url).toBe(yx.apiUrl);
    const parsed = JSON.parse(body!) as { requestBody: { appCode: string; token: string } };
    expect(parsed.requestBody.appCode).toBe('emp-01');
    expect(parsed.requestBody.token).toBe('tok-abc');
  });

  it('pushToChannel：returnStatus=S 成功返回 yanxunSeqNo（与报文 consumerSeqNo 一致）；sendTestMessage 透传 yanxun 配置（appCode 回退 consumerId）', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return { ok: true, status: 200, json: async () => ({ responseHead: { returnStatus: 'S' } }) } as unknown as Response;
    });
    // seqNo 留痕（2026-09-10 燕讯静默丢投排查）：S ≠ 已投递，凭返回的 seqNo 找平台方定位
    const r = await pushToChannel(yxDef, { ...msg(), employeeId: 'emp-01' }, undefined, 10_000, yx);
    const sent = bodies[0] as { requestHead: { consumerSeqNo: string } };
    expect(r.yanxunSeqNo).toBe(sent.requestHead.consumerSeqNo);
    expect(r.yanxunSeqNo).toMatch(/^R0251\d{8}\d{6}[0-9a-f]{16}$/);
    await expect(sendTestMessage(yxDef, undefined, yx)).resolves.toMatchObject({ yanxunSeqNo: expect.any(String) });
    expect(((bodies[1] as { requestBody: Record<string, unknown> }).requestBody).appCode).toBe('0251');
    expect(JSON.stringify(bodies[1])).toContain('[测试] 通知渠道 燕讯');
    // 燕讯测试消息 = 纯文本自检文案（不发 markdown 样例——渠道不渲染，发富格式只会显示原始符号）
    expect(((bodies[1] as { requestBody: { content: string } }).requestBody).content).toContain('渲染自检（纯文本渠道）');
    expect(((bodies[1] as { requestBody: { content: string } }).requestBody).content).not.toContain('| 字段 |');
    expect(((bodies[1] as { requestBody: { content: string } }).requestBody).content).not.toContain('```');
  });
});

describe('渠道凭据密文化（2026-09-11 P0 安全批）', () => {
  const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

  it('encryptChannelSecrets：主密钥在场时 secret/token 加密为 enc:v1:，未填字段不带，已密文幂等跳过', () => {
    const def: NotificationChannelDef = {
      id: 'd1', type: 'yanxun', name: '燕讯', webhookUrl: '', token: 'tok-plain', enabled: true,
    };
    const enc = encryptChannelSecrets(def, { DDW_CRED_KEY: KEY });
    expect(enc.token).toMatch(/^enc:v1:/);
    expect(enc.token).not.toBe('tok-plain');
    // 已密文原样返回（PUT 回填既有密文不二次加密）
    expect(encryptChannelSecrets(enc, { DDW_CRED_KEY: KEY }).token).toBe(enc.token);
    // dingtalk 无 secret：字段不出现
    const dt: NotificationChannelDef = { id: 'd2', type: 'dingtalk', name: '钉钉', webhookUrl: 'http://x', enabled: true };
    expect(encryptChannelSecrets(dt, { DDW_CRED_KEY: KEY })).toEqual(dt);
  });

  it('主密钥未设置 = 明文原样入库（现状零回归，doctor 明文巡检兜底）', () => {
    const def: NotificationChannelDef = {
      id: 'd1', type: 'yanxun', name: '燕讯', webhookUrl: '', token: 'tok-plain', enabled: true,
    };
    expect(encryptChannelSecrets(def, {})).toEqual(def);
  });

  it('pushToChannel 发送时解密：库里 enc:v1: 密文经 resolveChannelSecrets 还原明文上送', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      calls.push(`${url}|${init!.body as string}`);
      return { ok: true, status: 200, json: async () => ({ responseHead: { returnStatus: 'S' } }) } as unknown as Response;
    });
    const token = encryptSecret('tok-secret', KEY);
    const def: NotificationChannelDef = {
      id: 'yx1', type: 'yanxun', name: '燕讯', webhookUrl: '', token, enabled: true,
    };
    const head = { serviceCode: '1', serviceScene: '1', lglBrId: '1', consumerId: '0251', orgConsumerId: '1', channelTyp: '1', filFlg: '0' };
    await pushToChannel(def, msg(), undefined, 10_000, { apiUrl: 'http://yx.local/api', head }, { DDW_CRED_KEY: KEY });
    const parsed = JSON.parse(calls[0]!.split('|')[1]!) as { requestBody: { token: string } };
    expect(parsed.requestBody.token).toBe('tok-secret'); // 密文已解密上送，密文本身不出网
  });
});

describe('通知要素行（2026-09-11 用户需求：哪个数字员工/哪个任务/什么时间点）', () => {
  const wecomDef: NotificationChannelDef = { id: 'w1', type: 'wecom', name: '企微', webhookUrl: 'https://qy.local', enabled: true };
  const dingDef: NotificationChannelDef = { id: 'd1', type: 'dingtalk', name: '钉钉', webhookUrl: 'https://oapi.local', enabled: true };
  const at = '2026-09-11 11:45:30';
  const rich = { ...msg('t9'), employeeId: 'emo-01', employeeName: '炼气期-小郑', taskTitle: '行内AI网关文档补全', at };

  it('markdown 渠道：要素行列表化，顺序 = 标题→员工→任务→时间→摘要→直达', () => {
    const w = buildChannelPayload(wecomDef, rich, 'http://c.local');
    const c = (w.body.markdown as { content: string }).content;
    expect(c).toContain('- **数字员工**：炼气期-小郑');
    expect(c).toContain('- **任务**：行内AI网关文档补全（t9）');
    expect(c).toContain(`- **时间**：${at}`);
    const i = ['**任务 t9 执行失败**', '数字员工**', '任务**', '时间**', 'verify 挂了', '[直达]'].map((k) => c.indexOf(k));
    expect(i.every((v, n) => v >= 0 && (n === 0 || v > i[n - 1]!))).toBe(true);
  });

  it('dingtalk text 渠道：要素行纯文本（无 markdown 符号）', () => {
    const d = buildChannelPayload(dingDef, rich, 'http://c.local');
    const c = (d.body.text as { content: string }).content;
    expect(c).toContain('数字员工：炼气期-小郑');
    expect(c).toContain('任务：行内AI网关文档补全（t9）');
    expect(c).toContain(`时间：${at}`);
    expect(c).not.toContain('- **');
  });

  it('最小消息零回归：无要素字段 = 原格式逐字不变（不出现空洞标签）', () => {
    const w = buildChannelPayload(wecomDef, msg('t0'), undefined);
    expect((w.body.markdown as { content: string }).content).toBe('**任务 t0 执行失败**\nverify 挂了');
    const d = buildChannelPayload(dingDef, msg('t0'), undefined);
    expect((d.body.text as { content: string }).content).toBe('任务 t0 执行失败\nverify 挂了');
  });

  it('员工名缺省回退 employeeId；只有 employeeId 时同样出要素行', () => {
    const w = buildChannelPayload(wecomDef, { ...msg('t1'), employeeId: 'emo-01', at }, undefined);
    const c = (w.body.markdown as { content: string }).content;
    expect(c).toContain('- **数字员工**：emo-01');
  });

  it('sendTestMessage：复杂 markdown 渲染自检样例（表格/代码块/引用/列表）+ 时间要素', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return { ok: true, status: 200 } as Response;
    });
    await sendTestMessage(wecomDef);
    const c = (bodies[0] as { markdown: { content: string } }).markdown.content;
    expect(c).toContain('渲染自检');            // 标题语法
    expect(c).toContain('| 字段 | 值 |');      // 表格
    expect(c).toContain('```');                // 代码块
    expect(c).toContain('> 引用块');           // 引用
    expect(c).toContain('1. 有序第一步');      // 有序列表
    expect(c).toContain('- **时间**：');       // 要素行
  });

  it('localDateTimeString：YYYY-MM-DD HH:mm:ss 补零格式', () => {
    expect(localDateTimeString(new Date(2026, 8, 11, 9, 8, 7))).toBe('2026-09-11 09:08:07');
  });
});
