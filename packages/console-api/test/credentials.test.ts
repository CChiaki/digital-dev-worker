import { describe, it, expect } from 'vitest';
import {
  generateMasterKey, encryptSecret, decryptSecret, resolveSecret, checkMasterKey, MASTER_KEY_ENV,
} from '../src/team/credentials.js';
import { parseRuntimeConfig, resolveRuntimeSecrets } from '../src/team/runtime-config.js';

/**
 * P11-T1 凭据加密：AES-256-GCM 密文落盘（enc:v1:），主密钥 DDW_CRED_KEY 环境变量注入；
 * 明文/密文两用（明文零回归）；解密失败启动即报错、错误可读。
 */

describe('凭据加密（credentials）', () => {
  it('roundtrip：加密 → 解密还原明文；同明文两次加密密文不同（随机 iv）', () => {
    const key = generateMasterKey();
    const enc1 = encryptSecret('sk-test-1234567890', key);
    const enc2 = encryptSecret('sk-test-1234567890', key);
    expect(enc1).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(enc1).not.toBe(enc2);
    expect(decryptSecret(enc1, key)).toBe('sk-test-1234567890');
    expect(decryptSecret(enc2, key)).toBe('sk-test-1234567890');
  });

  it('resolveSecret 明文透传（P9 零回归）', () => {
    expect(resolveSecret('plain-key', {})).toBe('plain-key');
    expect(() => resolveSecret('enc:v1:fake', { [MASTER_KEY_ENV]: generateMasterKey() })).toThrowError(/密文格式不完整/); // 走解密路径
  });

  it('密文配置但缺主密钥：可读报错（不带病运行）', () => {
    expect(() => resolveSecret('enc:v1:a:b:c', {})).toThrowError(/DDW_CRED_KEY 未设置/);
  });

  it('错主密钥：GCM 校验失败，报错可读', () => {
    const enc = encryptSecret('secret', generateMasterKey());
    expect(() => decryptSecret(enc, generateMasterKey())).toThrowError(/主密钥不匹配或密文已被篡改/);
  });

  it('密文被篡改：auth 失败拒绝解密；主密钥长度无效可检测', () => {
    const key = generateMasterKey();
    const enc = encryptSecret('secret', key);
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64'); // 篡改密文体
    expect(() => decryptSecret(parts.join(':'), key)).toThrowError(/篡改/);
    expect(checkMasterKey(Buffer.from('short').toString('base64')).ok).toBe(false);
    expect(checkMasterKey(generateMasterKey()).ok).toBe(true);
    expect(checkMasterKey(undefined).ok).toBe(false);
  });

  it('parseRuntimeConfig + resolveRuntimeSecrets 集成：yaml 密文 apiKey 解密、明文原样', () => {
    const key = generateMasterKey();
    const encKey = encryptSecret('real-api-key', key);
    const yaml = `
profiles: [{ id: emp-01, name: 小数, role: backend, skills: [backend] }]
workspaceRoot: ./ws
sessionsRoot: ./sessions
routes:
  - callType: code
    primary: { baseUrl: http://m/v1, apiKey: "${encKey}", model: glm }
  - callType: chat
    primary: { baseUrl: http://m/v1, apiKey: plaintext-key, model: glm }
`;
    const config = resolveRuntimeSecrets(parseRuntimeConfig(yaml), { [MASTER_KEY_ENV]: key });
    expect(config.routes[0]!.primary.apiKey).toBe('real-api-key');
    expect(config.routes[1]!.primary.apiKey).toBe('plaintext-key');

    // 缺主密钥：loadRuntimeConfig 语义（解密即失败）
    expect(() => resolveRuntimeSecrets(parseRuntimeConfig(yaml), {})).toThrowError(/DDW_CRED_KEY 未设置/);
  });
});
