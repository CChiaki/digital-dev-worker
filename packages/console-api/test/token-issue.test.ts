import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decryptSecret, generateMasterKey } from '../src/team/credentials.js';
import {
  generateApiToken,
  issueToken,
  yamlLineFor,
  detectIndent,
  insertTokenLine,
} from '../src/team/token-issue.js';

/**
 * token 签发命令纯逻辑层单测（2026-09-11 P2 产品批补充）：
 * 生成格式 / enc:v1 往返 / yaml 行格式 / 三种 yaml 形态的插入语义。
 * 背景：手工维护 token 时密文明文易混（实测踩坑），签发命令一处收口。
 */
describe('token 签发（token-issue）', () => {
  it('generateApiToken：ddw- + 32 位 hex，两次生成不重复', () => {
    const t1 = generateApiToken();
    const t2 = generateApiToken();
    expect(t1).toMatch(/^ddw-[0-9a-f]{32}$/);
    expect(t1).not.toBe(t2); // 随机性（128bit，碰撞概率可忽略——同进程两次不等即可）
  });

  it('issueToken：主密钥在场产 enc:v1 密文且可解回明文；缺场 tokenEnc=null', () => {
    const key = generateMasterKey();
    const withKey = issueToken('张三', key);
    expect(withKey.name).toBe('张三');
    expect(withKey.token).toMatch(/^ddw-/);
    expect(withKey.tokenEnc).toMatch(/^enc:v1:/);
    // 往返：密文用主密钥解回 = 签发明文（guard 启动时同路径解密比对）
    expect(decryptSecret(withKey.tokenEnc!, key)).toBe(withKey.token);

    const noKey = issueToken('李四', undefined);
    expect(noKey.tokenEnc).toBeNull(); // 无主密钥 → 调用方提示明文落盘风险
  });

  it('yamlLineFor：密文优先、值加引号、name 原位内联', () => {
    const enc = issueToken('张三', generateMasterKey());
    expect(yamlLineFor(enc)).toBe(`- { name: 张三, token: "${enc.tokenEnc}" }`);
    const plain = { name: '李四', token: 'ddw-abc', tokenEnc: null };
    expect(yamlLineFor(plain)).toBe('- { name: 李四, token: "ddw-abc" }');
  });

  it('detectIndent：跟随既有条目缩进；无条目按 tokens: 行 +2', () => {
    const lines = [
      'auth:',
      '  tokens:',
      '    - { name: a, token: "x" }',
    ];
    expect(detectIndent(lines, 1)).toBe('    ');
    const empty = ['auth:', '  tokens:'];
    expect(detectIndent(empty, 1)).toBe('    '); // tokens 缩进 2 + 2
  });

  it('insertTokenLine 情形1：已有条目 → 同缩进追加在最后一条之后', () => {
    const yaml = [
      'port: 3100',
      'auth:',
      '  tokens:',
      '    - { name: 张三, token: "t1" }',
      'storage:',
      '  driver: sqlite',
    ].join('\n');
    const out = insertTokenLine(yaml, '- { name: 李四, token: "t2" }');
    const lines = out.split('\n');
    // 插在张三行后、storage: 前，缩进与既有条目一致
    const idx = lines.findIndex((l) => l.includes('李四'));
    expect(lines[idx]).toBe('    - { name: 李四, token: "t2" }');
    expect(lines[idx - 1]).toContain('张三');
    expect(lines[idx + 1]).toBe('storage:');
  });

  it('insertTokenLine 情形2：tokens: [] 空数组字面量 → 展开成条目', () => {
    const yaml = 'auth:\n  tokens: []\nport: 3100\n';
    const out = insertTokenLine(yaml, '- { name: 王五, token: "t3" }');
    expect(out).toBe('auth:\n  tokens:\n    - { name: 王五, token: "t3" }\nport: 3100\n');
  });

  it('insertTokenLine 情形3：无 auth 段 → 文件末尾整段追加（含注释头，补齐结尾换行）', () => {
    const yaml = 'port: 3100\nstorage:\n  driver: sqlite'; // 无结尾换行
    const out = insertTokenLine(yaml, '- { name: 赵六, token: "t4" }');
    expect(out).toBe(
      'port: 3100\nstorage:\n  driver: sqlite\n' +
      '# API 鉴权（token 命令自动追加）\nauth:\n  tokens:\n    - { name: 赵六, token: "t4" }\n',
    );
  });

  it('insertTokenLine 情形1 端到端：真实 yaml 往返 + 随机令牌防猜测', () => {
    // 模拟真实签发路径：随机令牌 + 主密钥密文 → 插入 → guard 侧同语义可解
    const key = generateMasterKey();
    const issued = issueToken('巡检', key);
    const yaml = 'auth:\n  tokens:\n    - { name: 张三, token: "enc:v1:' + randomBytes(8).toString('base64') + '" }\n';
    const out = insertTokenLine(yaml, yamlLineFor(issued));
    expect(out).toContain(issued.tokenEnc!); // 密文行落盘
    expect(out).not.toContain(issued.token); // 明文绝不落 yaml（主密钥在场时）
    expect(decryptSecret(issued.tokenEnc!, key)).toBe(issued.token);
  });
});
