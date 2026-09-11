import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveSecret, encryptSecret, MASTER_KEY_ENV } from './credentials.js';

/** 外部通知渠道定义（2026-09-06；2026-09-10 增燕讯）：钉钉机器人 / 企业微信机器人 / 通用 Webhook / 内部燕讯 */
export interface NotificationChannelDef {
  id: string;
  type: 'dingtalk' | 'wecom' | 'webhook' | 'yanxun';
  name: string;
  webhookUrl: string;
  /** 钉钉加签 secret（可选） */
  secret?: string;
  /** 燕讯机器人 access_token（type=yanxun 必填；原 webhookUrl 配置项改为它） */
  token?: string;
  enabled: boolean;
}

/** 燕讯 requestHead 固定参数（yaml yanxun 段配置）；tranDate/tranTime/consumerSeqNo 发送时生成 */
export interface YanxunHead {
  serviceCode: string;
  serviceScene: string;
  lglBrId: string;
  consumerId: string;
  orgConsumerId: string;
  channelTyp: string;
  filFlg: string;
}

/** 燕讯渠道接入配置（runtime yaml `yanxun` 段）：sendRobotTex 端点 + 报文头固定参数 + @所有人开关 */
export interface YanxunConfig {
  apiUrl: string;
  head: YanxunHead;
  /** 是否 @所有人（请求体 isAtAll：true→'1'；全局配置，缺省 '0'） */
  isAtAll?: boolean;
}

export interface ChannelStore {
  list(): Promise<NotificationChannelDef[]>;
  upsert(def: NotificationChannelDef): Promise<void>;
  remove(id: string): Promise<boolean>;
}

/** JSON 文本 → 渠道数组（非数组形状抛可读错误，防止损坏数据进入缓存） */
function parseRegistry(raw: string): NotificationChannelDef[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('通知渠道文件格式错误: 应为对象数组');
  return parsed as NotificationChannelDef[];
}

/** 仅 ENOENT 视为"文件不存在"；其余读/解析错误原样上抛（损坏/权限不得被当作不存在） */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** upsert 前的形状与取值校验（错误信息可读，HTTP 层原样 400） */
export function validateChannelDef(def: NotificationChannelDef): void {
  if (typeof def.id !== 'string' || !def.id.trim()) throw new Error('渠道 id 必须是非空字符串');
  if (!['dingtalk', 'wecom', 'webhook', 'yanxun'].includes(def.type)) throw new Error('渠道 type 必须是 dingtalk | wecom | webhook | yanxun');
  if (typeof def.name !== 'string' || !def.name.trim()) throw new Error('渠道 name 必须是非空字符串');
  if (def.type === 'yanxun') {
    // 燕讯不走 webhookUrl（配置项是机器人 access_token），但 token 必填
    if (typeof def.token !== 'string' || !def.token.trim()) throw new Error('燕讯渠道必须配置机器人 access_token');
  } else {
    if (typeof def.webhookUrl !== 'string' || !/^https?:\/\//.test(def.webhookUrl)) throw new Error('渠道 webhookUrl 必须是 http(s) 地址');
  }
  if (typeof def.enabled !== 'boolean') throw new Error('渠道 enabled 必须是布尔值');
}

/** 渠道注册表文件实现：单 JSON 文件 + mutate 队列串行化（模式同 FileCapabilityStore） */
export class FileChannelStore implements ChannelStore {
  private cache: NotificationChannelDef[] | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async load(): Promise<NotificationChannelDef[]> {
    if (this.cache) return this.cache;
    try {
      this.cache = parseRegistry(await readFile(this.filePath, 'utf8'));
    } catch (err) {
      // 仅"文件不存在"视为尚未初始化；损坏/权限等其他读错误原样上抛，
      // 不得静默降级为空表缓存（否则 flush 会把残缺数据写回）
      if (isEnoent(err)) {
        this.cache = [];
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  private async flush(defs: NotificationChannelDef[]): Promise<void> {
    this.cache = defs;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.notification-channels-${process.pid}.tmp`);
    await writeFile(tmpPath, JSON.stringify(defs, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }

  list(): Promise<NotificationChannelDef[]> {
    return this.load().then((defs) => defs.map((d) => structuredClone(d)));
  }

  upsert(def: NotificationChannelDef): Promise<void> {
    const run = this.queue.then(async () => {
      validateChannelDef(def);
      const defs = await this.load();
      const idx = defs.findIndex((d) => d.id === def.id);
      if (idx >= 0) defs[idx] = { ...def };
      else defs.push({ ...def });
      await this.flush(defs);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  remove(id: string): Promise<boolean> {
    const run = this.queue.then(async () => {
      const defs = await this.load();
      const next = defs.filter((d) => d.id !== id);
      if (next.length === defs.length) return false;
      await this.flush(next);
      return true;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** 钉钉加签：secret → `&timestamp=<ms>&sign=<urlencode(base64(hmac-sha256(secret)))>` */
function dingtalkSign(webhookUrl: string, secret: string): string {
  const ts = Date.now();
  const sign = createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
  return `${webhookUrl}&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
}

/** 消息侧字段（推送只读这些；employeeId 供燕讯 appCode） */
export interface ChannelMessage {
  type: string;
  title: string;
  summary: string;
  taskId: string;
  employeeId?: string;
  /** 员工显示名（2026-09-11 用户需求：通知要一眼看出「哪个数字员工」）；缺省回退 employeeId */
  employeeName?: string;
  /** 任务标题（2026-09-11 用户需求：「哪个任务」——taskId 之外的人读标题） */
  taskTitle?: string;
  /** 事件发生时间点（2026-09-11 用户需求：「在什么时间点」），如 2026-09-11 11:45:30 */
  at?: string;
}

/** 本地时间 YYYY-MM-DD HH:mm:ss（通知「时间」要素行；与燕讯报文头 localDate/localTime 同风格） */
export function localDateTimeString(d = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 通知要素行（2026-09-11 用户需求）：每条通知必须一眼回答——哪个数字员工、哪个任务、什么时间点；
 *  「触发了什么」由 title（消息类型）+ summary（事项明细）承担。缺省字段跳过该行
 *  （测试消息/无员工场景不出现空洞标签，既有断言零回归） */
function metaLines(m: ChannelMessage): string[] {
  const lines: string[] = [];
  if (m.employeeName || m.employeeId) lines.push(`数字员工：${m.employeeName ?? m.employeeId}`);
  if (m.taskTitle) lines.push(`任务：${m.taskTitle}（${m.taskId}）`);
  if (m.at) lines.push(`时间：${m.at}`);
  return lines;
}

/** 本地时间 YYYYMMDD / HHMMSS（燕讯报文头日期时间，示例 20260910 / 153004） */
function localDate(d = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function localTime(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 全局流水号：R0251 + tranDate + tranTime + 16 位随机 hex（consumerSeqNo / orgConsumerSeqNo 各自独立生成） */
function consumerSeqNo(prefix: string, tranDate: string, tranTime: string): string {
  return `${prefix}${tranDate}${tranTime}${randomBytes(8).toString('hex')}`;
}

/** 消息 → 渠道 payload（纯函数；consoleUrl 直达链接可空；yanxun 为燕讯接入配置，type=yanxun 时必传）。
 *  yanxunSeqNo = 本次报文的 consumerSeqNo（全局流水号）：燕讯侧「收单成功（returnStatus=S）但未投递」
 *  时凭此流水号排查（2026-09-10 实测存在静默丢投：同内容两条 S 一到一不到） */
export function buildChannelPayload(
  def: NotificationChannelDef,
  message: ChannelMessage,
  consoleUrl?: string,
  yanxun?: YanxunConfig,
): { url: string; body: Record<string, unknown>; yanxunSeqNo?: string } {
  const link = consoleUrl ? `${consoleUrl}/tasks/${message.taskId}` : '';
  const meta = metaLines(message);
  const text = [message.title, ...meta, message.summary, link ? `直达: ${link}` : ''].filter(Boolean).join('\n');
  if (def.type === 'dingtalk') {
    return {
      url: def.secret ? dingtalkSign(def.webhookUrl, def.secret) : def.webhookUrl,
      body: { msgtype: 'text', text: { content: text } },
    };
  }
  // markdown 渠道（wecom/yanxun）：标题加粗 + 要素行列表化 + 摘要 + 直达链接
  const md = [
    `**${message.title}**`,
    ...meta.map((l) => {
      const i = l.indexOf('：');
      return `- **${l.slice(0, i)}**：${l.slice(i + 1)}`;
    }),
    message.summary,
    link ? `[直达](${link})` : '',
  ].filter(Boolean).join('\n');
  if (def.type === 'wecom') {
    return {
      url: def.webhookUrl,
      body: { msgtype: 'markdown', markdown: { content: md } },
    };
  }
  if (def.type === 'yanxun') {
    if (!yanxun) throw new Error(`渠道 ${def.name} 推送失败: 燕讯渠道需在 runtime yaml 配置 yanxun 段（apiUrl + requestHead）`);
    const tranDate = localDate();
    const tranTime = localTime();
    const seqPrefix = `R${yanxun.head.consumerId}`;
    const seqNo = consumerSeqNo(seqPrefix, tranDate, tranTime);
    return {
      url: yanxun.apiUrl,
      yanxunSeqNo: seqNo,
      body: {
        requestHead: {
          ...yanxun.head,
          consumerSeqNo: seqNo,
          orgConsumerSeqNo: consumerSeqNo(seqPrefix, tranDate, tranTime),
          tranDate,
          tranTime,
        },
        requestBody: {
          token: def.token,
          // appCode 传员工 id；测试消息等无员工场景回退 consumerId，保证报文形状完整
          appCode: message.employeeId ?? yanxun.head.consumerId,
          // 纯文本 content（2026-09-11 实测：燕讯 sendRobotText 不渲染 markdown——##/**/表格/代码块
          // 全部原样显示，见用户实收截图；与钉钉 text 同构，靠要素行保证可读性）
          content: text,
          // @所有人为全局配置（yaml yanxun.isAtAll），页面上不配；缺省 '0'
          isAtAll: yanxun.isAtAll === true ? '1' : '0',
        },
      },
    };
  }
  return { url: def.webhookUrl, body: { ...message, ...(consoleUrl ? { consoleUrl } : {}) } };
}

/** 推送单渠道：非 2xx 抛错（调用方记日志不阻断）；yanxun 为燕讯接入配置（type=yanxun 渠道必传）。
 *  燕讯网关 HTTP 200 也可能带业务失败（returnStatus='F'，如 ip 不在白名单）——校验 responseHead.returnStatus，
 *  非 'S' 视为失败抛 returnCode/returnMsg（实测 2026-09-10：999992 ip 不在白名单）。
 *  成功返回 yanxunSeqNo（燕讯全局流水号）供审计留痕：S ≠ 已投递，静默丢投凭此号找平台方排查。 */
export async function pushToChannel(
  def: NotificationChannelDef,
  message: ChannelMessage,
  consoleUrl?: string,
  timeoutMs = 10_000,
  yanxun?: YanxunConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ yanxunSeqNo?: string }> {
  // 凭据解密（2026-09-11）：库里可能是 enc:v1: 密文，发送前单点统一 resolve
  const { url, body, yanxunSeqNo } = buildChannelPayload(resolveChannelSecrets(def, env), message, consoleUrl, yanxun);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`渠道 ${def.name} 推送失败: HTTP ${res.status}`);
  if (def.type === 'yanxun') {
    const out = await res.json().catch(() => null) as
      | { responseHead?: { returnStatus?: string; ret?: { returnCode?: string; returnMsg?: string }[] } }
      | null;
    const head = out?.responseHead;
    if (!head || head.returnStatus !== 'S') {
      const ret = head?.ret?.[0];
      throw new Error(`渠道 ${def.name} 推送失败: 燕讯返回 ${ret?.returnCode ?? head?.returnStatus ?? '未知错误'}${ret?.returnMsg ? `（${ret.returnMsg}）` : ''}`);
    }
    return { yanxunSeqNo };
  }
  return {};
}

/** 测试消息（渠道页按钮）；yanxun 为燕讯接入配置（type=yanxun 渠道必传）；返回同 pushToChannel。
 *  内容按渠道渲染能力区分（2026-09-11 用户实测：燕讯 sendRobotText 不渲染 markdown）：
 *  企微（markdown msgtype）发富格式自检样例实测渲染子集；燕讯/钉钉（纯文本）发要素自检文案 */
export async function sendTestMessage(def: NotificationChannelDef, consoleUrl?: string, yanxun?: YanxunConfig): Promise<{ yanxunSeqNo?: string }> {
  const markdownSample = [
    '## 渲染自检：复杂 Markdown',
    '**加粗** · *斜体* · `行内代码` · [普通链接](https://example.com)',
    '',
    '- 无序列表项甲',
    '- 无序列表项乙',
    '',
    '1. 有序第一步',
    '2. 有序第二步',
    '',
    '> 引用块：能正确缩进渲染说明引用语法可用',
    '',
    '| 字段 | 值 |',
    '| --- | --- |',
    '| 表格列一 | 单元格内容 |',
    '| 表格列二 | **加粗单元格** |',
    '',
    '```',
    'const hello = "代码块";',
    'if (hello) {',
    '  console.log(hello);',
    '}',
    '```',
    '',
    '---',
    '以上各元素若显示为原始符号（如 **、##、|---|），说明该渠道不支持对应 markdown 语法。',
  ].join('\n');
  const plainSample = [
    '渲染自检（纯文本渠道）：',
    '本渠道不渲染 markdown（实测 ##、**、表格等符号原样显示），',
    '正式通知为纯文本格式：标题 + 数字员工/任务/时间要素行 + 事项摘要 + 直达链接。',
    '收到本条即说明通知链路通畅。',
  ].join('\n');
  const summary = def.type === 'wecom' ? markdownSample : plainSample;
  return pushToChannel(def, { type: 'test', title: `[测试] 通知渠道 ${def.name}`, summary, taskId: 'test', at: localDateTimeString() }, consoleUrl, 10_000, yanxun);
}

/**
 * 渠道凭据入库加密（2026-09-11 P0 安全批）：secret/token 支持 `enc:v1:` 密文落库——
 * DDW_CRED_KEY 在场时明文值入库前加密，已是密文/未填写原样返回；主密钥未设置 = 明文入库
 * （现状零回归，doctor 明文凭据巡检兜底提示）。与 yaml 凭据同一套 enc:v1 机制（cred enc 命令生成）。
 */
export function encryptChannelSecrets(def: NotificationChannelDef, env: NodeJS.ProcessEnv = process.env): NotificationChannelDef {
  const masterKey = env[MASTER_KEY_ENV];
  if (!masterKey) return def;
  const enc = (v: string): string => (v.startsWith('enc:v1:') ? v : encryptSecret(v, masterKey));
  return {
    ...def,
    ...(def.secret ? { secret: enc(def.secret) } : {}),
    ...(def.token ? { token: enc(def.token) } : {}),
  };
}

/**
 * 渠道凭据发送时解密（2026-09-11）：库里可能是 enc:v1: 密文（encryptChannelSecrets 写入）或明文
 * （未配主密钥时期入库的存量），pushToChannel 单点统一 resolve——密文且缺主密钥 = 可读错误（不带病推送）。
 */
function resolveChannelSecrets(def: NotificationChannelDef, env: NodeJS.ProcessEnv = process.env): NotificationChannelDef {
  return {
    ...def,
    ...(def.secret ? { secret: resolveSecret(def.secret, env) } : {}),
    ...(def.token ? { token: resolveSecret(def.token, env) } : {}),
  };
}
