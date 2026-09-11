import type { ToolInterceptor } from './types.js';

/** S2 毕业的黑名单。P1 版本=模式清单；P4 容器化后升级为"白名单+最小 shell"。 */
const BLOCKED: { name: string; re: RegExp }[] = [
  { name: '递归强删', re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/ },
  { name: '根/设备写入', re: /\brm\s+-[a-zA-Z]*\s+\/(\s|$)/ },
  { name: '关机重启', re: /\b(shutdown|reboot|halt|poweroff)\b/ },
  { name: '格式化文件系统', re: /\bmkfs\b/ },
  { name: '磁盘镜像写入', re: /\bdd\s+if=/ },
  { name: 'fork炸弹', re: /:\(\)\s*\{\s*:\|:&\s*\};:/ },
  { name: '公网外呼', re: /\b(curl|wget)\b[^|]*\bhttps?:\/\/(?!(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|localhost))/ },
  { name: '权限提升', re: /\b(sudo|su)\s/ },
  { name: '计划任务持久化', re: /\bcrontab\b/ },
];

export class BashBlacklist implements ToolInterceptor {
  name = 'bash-blacklist';

  check(input: { toolName: string; args: Record<string, unknown> }): { block: boolean; reason: string } | null {
    if (input.toolName !== 'bash' && input.toolName !== 'run_cmd') return null;
    const cmd = String(input.args['cmd'] ?? input.args['command'] ?? '');
    if (!cmd) return null;
    for (const p of BLOCKED) {
      if (p.re.test(cmd)) {
        return { block: true, reason: `run_cmd 被安全策略拦截（${p.name}）：请改用安全方式完成任务` };
      }
    }
    return null;
  }
}
