import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 凭据加密（P11-T1，spec 4.7/7.3「一期加密配置」）：
 * 模型路由 apiKey 等敏感值以 AES-256-GCM 密文落盘（yaml 可进 git/可交接），
 * 主密钥由环境变量 DDW_CRED_KEY 注入（base64 的 32 字节，不落盘，运维生成一次）。
 * 零依赖（node:crypto 内置），契合银行内网完全离线原则。
 */

/** 密文前缀 + 版本（未来换算法/加字段升 v2，旧配置不受影响） */
const ENC_PREFIX = 'enc:v1:';

export const MASTER_KEY_ENV = 'DDW_CRED_KEY';

/** 生成主密钥（base64 的 32 字节）；CLI `cred key` 输出给运维注入环境变量 */
export function generateMasterKey(): string {
  return randomBytes(32).toString('base64');
}

const decodeMasterKey = (masterKey: string): Buffer => {
  const key = Buffer.from(masterKey, 'base64');
  if (key.length !== 32) {
    throw new Error(`主密钥长度无效：期望 32 字节（base64），得到 ${key.length} 字节。请用 "cred key" 重新生成。`);
  }
  return key;
};

/** 明文 → `enc:v1:<iv>:<ct>:<tag>`（iv 每次 12 字节随机，同一明文两次加密产生不同密文） */
export function encryptSecret(plain: string, masterKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', decodeMasterKey(masterKey), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${ENC_PREFIX}${iv.toString('base64')}:${ct.toString('base64')}:${cipher.getAuthTag().toString('base64')}`;
}

/** `enc:v1:...` → 明文；非密文格式 / 篡改（GCM auth fail）/ 错 key 均抛可读错误 */
export function decryptSecret(enc: string, masterKey: string): string {
  if (!enc.startsWith(ENC_PREFIX)) {
    throw new Error(`凭据解密失败：不是有效的密文格式（应以 ${ENC_PREFIX} 开头）`);
  }
  const [ivB64, ctB64, tagB64] = enc.slice(ENC_PREFIX.length).split(':');
  if (!ivB64 || !ctB64 || !tagB64) {
    throw new Error('凭据解密失败：密文格式不完整（应为 enc:v1:<iv>:<ct>:<tag>）');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', decodeMasterKey(masterKey), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('凭据解密失败：主密钥不匹配或密文已被篡改（GCM 校验未通过）');
  }
}

/**
 * 密文/明文两用解析：`enc:v1:` 前缀 → 用主密钥解密；否则按明文原样返回（P9 零回归）。
 * 密文路径下缺主密钥 = 直接失败（宁可不起，不带病运行——模型集群 401 的报错远难排查）。
 */
export function resolveSecret(value: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!value.startsWith(ENC_PREFIX)) return value;
  const masterKey = env[MASTER_KEY_ENV];
  if (!masterKey) {
    throw new Error(`凭据解密失败：检测到密文配置（enc:v1:）但环境变量 ${MASTER_KEY_ENV} 未设置。请注入主密钥后启动。`);
  }
  return decryptSecret(value, masterKey);
}

/** 主密钥格式校验（doctor 巡检用）：可解码且 32 字节 → ok，否则给出原因 */
export function checkMasterKey(masterKey: string | undefined): { ok: boolean; detail: string } {
  if (!masterKey) return { ok: false, detail: `环境变量 ${MASTER_KEY_ENV} 未设置（明文配置可忽略此项）` };
  try {
    decodeMasterKey(masterKey);
    return { ok: true, detail: '主密钥格式有效（32 字节 base64）' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
