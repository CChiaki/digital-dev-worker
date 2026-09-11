import { randomBytes } from 'node:crypto';
import { encryptSecret } from './credentials.js';

/**
 * API 访问令牌签发（2026-09-11 P2 产品批补充）：`node cli.ts token <name> [--yaml <path>]`
 * 的纯逻辑层。token 明文 = `ddw-` + 32 位随机 hex（管理员自定字符串亦可，此处给随机默认防弱口令）；
 * 主密钥在场则 enc:v1 密文落 yaml（防配置文件泄漏即失守），否则明文 + 警告。
 *
 * 背景：token 此前靠手写，管理员容易把 yaml 里的 enc:v1 密文当明文分发给使用者——
 * 密文比对恒 401（实测踩坑），录入框弹不停。签发命令把「生成明文 + 出 yaml 行 +
 * 可选写入」一次做完，明文/密文不再混淆。
 */

export interface IssuedToken {
  /** 操作者名（yaml auth.tokens[].name，鉴权通过后作为 operator 留痕） */
  name: string;
  /** 明文令牌（分发给使用者；客户端原样携带） */
  token: string;
  /** enc:v1 密文（主密钥在场时；缺省 null = yaml 只能落明文） */
  tokenEnc: string | null;
}

/** 生成随机令牌：ddw- + 16 字节 hex（不可猜；非自增无规律，配合限流不构成枚举面） */
export function generateApiToken(): string {
  return `ddw-${randomBytes(16).toString('hex')}`;
}

/** 签发：主密钥在场 → 附密文；缺场 → tokenEnc=null（调用方提示明文落盘风险） */
export function issueToken(name: string, masterKey?: string): IssuedToken {
  const token = generateApiToken();
  return {
    name,
    token,
    tokenEnc: masterKey ? encryptSecret(token, masterKey) : null,
  };
}

/** yaml auth.tokens 条目行（密文优先，占位 {/} 与既有行格式一致） */
export function yamlLineFor(t: IssuedToken): string {
  const value = t.tokenEnc ?? t.token;
  return `- { name: ${t.name}, token: "${value}" }`;
}

/**
 * 目标插入缩进探测：从 tokens: 下既有条目行取前导空格；无条目时按 tokens: 行缩进 + 2。
 * 独立小函数便于单测缩进语义（yaml 缩进错误 = 启动解析失败，必须跟随现状）。
 */
export function detectIndent(lines: string[], tokensLineIdx: number): string {
  for (let i = tokensLineIdx + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s+- \{ name: /.test(l)) return l.match(/^\s+/)?.[0] ?? '    ';
    if (l.trim() !== '' && !/^\s+#/.test(l)) break; // 块已结束（非注释非空行）
  }
  const tokensIndent = lines[tokensLineIdx]!.match(/^\s+/)?.[0] ?? '';
  return `${tokensIndent}  `;
}

/**
 * 把 token 行写进 yaml 文本（返回新文本；不落盘——落盘由 CLI 层做）：
 * 1) 已有 auth.tokens 且有条目 → 追加在最后一条之后（同缩进）
 * 2) auth.tokens 为空数组字面量（tokens: []）→ 展开成条目
 * 3) 无 auth 段 → 文件末尾整段追加（带注释头）
 * 找不到 auth: 但文件里已有其他结构也无妨——YAML 顶层键顺序无关。
 */
export function insertTokenLine(yamlText: string, line: string): string {
  const lines = yamlText.split('\n');
  // 情形 1/2：定位 auth: → tokens:
  for (let i = 0; i < lines.length; i++) {
    if (!/^auth:\s*$/.test(lines[i]!)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (/^\S/.test(l)) break; // auth 块结束
      const emptyTokens = l.match(/^(\s*)tokens:\s*\[\]\s*$/);
      if (emptyTokens) {
        const indent = `${emptyTokens[1]}  `;
        lines[j] = `${emptyTokens[1]}tokens:`;
        lines.splice(j + 1, 0, `${indent}${line}`);
        return lines.join('\n');
      }
      const tokens = l.match(/^(\s*)tokens:\s*$/);
      if (tokens) {
        const indent = detectIndent(lines, j);
        // 插到最后一个兄弟条目之后（注释行也算块内，插注释前会打断语义——保守插在块尾）
        let insertAt = j + 1;
        for (let k = j + 1; k < lines.length; k++) {
          const cand = lines[k]!;
          if (/^\s+- \{ name: /.test(cand)) insertAt = k + 1;
          else if (cand.trim() !== '' && !/^\s+#/.test(cand) && !/^\s+- /.test(cand)) break;
        }
        lines.splice(insertAt, 0, `${indent}${line}`);
        return lines.join('\n');
      }
    }
    break; // 只处理第一个 auth: 段
  }
  // 情形 3：整段追加（保证结尾换行干净）
  const head = yamlText.endsWith('\n') ? '' : '\n';
  return `${yamlText}${head}# API 鉴权（token 命令自动追加）\nauth:\n  tokens:\n    ${line}\n`;
}
