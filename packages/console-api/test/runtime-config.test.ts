import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRuntimeConfig, loadRuntimeConfig, resolveRuntimeSecrets } from '../src/team/runtime-config.js';
import { fileURLToPath } from 'node:url';
import { encryptSecret } from '../src/team/credentials.js';

// 主密钥约定：base64 的 32 字节（credentials.ts decodeMasterKey 校验）
const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

const exampleYaml = readFileSync(new URL('../../../examples/console-runtime.example.yaml', import.meta.url), 'utf8');
const baseYaml = (over = ''): string => `
profiles:
  - id: emp-01
    name: 小数
    role: backend
    skills: [backend, test]
    supervision:
      level: shadow
routes:
  - callType: chat
    primary: { name: m, baseUrl: "http://x/v1", apiKey: k, model: glm }
workspaceRoot: ./workspace
sessionsRoot: ./sessions
${over}
`;

describe('parseRuntimeConfig（运行时配置解析，P9-T2）', () => {
  it('样例 yaml 全量解析通过（含 supervision/fallback/bashWhitelist/tickIntervalMs）', () => {
    const cfg = parseRuntimeConfig(exampleYaml);
    expect(cfg.profiles).toHaveLength(3);
    expect(cfg.profiles[0]).toMatchObject({ id: 'emp-01', name: '小数', role: 'backend', supervision: { level: 'shadow' } });
    expect(cfg.routes.map((r) => r.callType)).toEqual(['chat', 'code', 'review', 'test']);
    expect(cfg.routes[1]!.fallback?.model).toBe('qwen3.8-27b');
    expect(cfg.tickIntervalMs).toBe(5000);
    expect(cfg.bashWhitelist).toContain('git');
  });

  it('最小配置通过；可选项缺省', () => {
    const cfg = parseRuntimeConfig(baseYaml());
    expect(cfg.profiles).toHaveLength(1);
    expect(cfg.tickIntervalMs).toBeUndefined();
    expect(cfg.bashWhitelist).toBeUndefined();
  });

  it('execMode（P13）：合法值透传，非法值报错可读', () => {
    expect(parseRuntimeConfig(baseYaml('execMode: fork\n')).execMode).toBe('fork');
    expect(parseRuntimeConfig(baseYaml('execMode: inproc\n')).execMode).toBe('inproc');
    expect(parseRuntimeConfig(baseYaml()).execMode).toBeUndefined();
    expect(() => parseRuntimeConfig(baseYaml("execMode: 'cluster'\n")))
      .toThrow(/execMode 必须是 inproc\/fork 之一/);
  });

  it('bashTimeoutMs（2026-09-10）：正整数透传，缺省 undefined，非法值报错可读', () => {
    expect(parseRuntimeConfig(baseYaml('bashTimeoutMs: 600000\n')).bashTimeoutMs).toBe(600000);
    expect(parseRuntimeConfig(baseYaml()).bashTimeoutMs).toBeUndefined();
    expect(() => parseRuntimeConfig(baseYaml('bashTimeoutMs: 0\n'))).toThrow(/bashTimeoutMs 必须是正整数/);
    expect(() => parseRuntimeConfig(baseYaml("bashTimeoutMs: '60s'\n"))).toThrow(/bashTimeoutMs 必须是正整数/);
  });

  it('maxTurns（2026-09-10）：正整数透传（每任务最大对话轮数），缺省 undefined，非法值报错可读', () => {
    expect(parseRuntimeConfig(baseYaml('maxTurns: 100\n')).maxTurns).toBe(100);
    expect(parseRuntimeConfig(baseYaml()).maxTurns).toBeUndefined();
    expect(() => parseRuntimeConfig(baseYaml('maxTurns: 0\n'))).toThrow(/maxTurns 必须是正整数/);
    expect(() => parseRuntimeConfig(baseYaml('maxTurns: 40.5\n'))).toThrow(/maxTurns 必须是正整数/);
  });

  it('retryPerItem（2026-09-11 P2 产品批）：非负整数透传（0 允许=失败即停），缺省 undefined，非法值报错可读', () => {
    expect(parseRuntimeConfig(baseYaml('retryPerItem: 2\n')).retryPerItem).toBe(2);
    expect(parseRuntimeConfig(baseYaml('retryPerItem: 0\n')).retryPerItem).toBe(0);
    expect(parseRuntimeConfig(baseYaml()).retryPerItem).toBeUndefined();
    expect(() => parseRuntimeConfig(baseYaml('retryPerItem: -1\n'))).toThrow(/retryPerItem 必须是非负整数/);
    expect(() => parseRuntimeConfig(baseYaml('retryPerItem: 1.5\n'))).toThrow(/retryPerItem 必须是非负整数/);
  });


  it('bashApproval 已退役（2026-09-11 盯梢三级改等级驱动）：旧 yaml 键静默忽略不炸，结果不带该字段', () => {
    const cfg = parseRuntimeConfig(baseYaml('bashApproval: true\n')) as unknown as Record<string, unknown>;
    expect(cfg.bashApproval).toBeUndefined();
  });

  it('错误信息可读：缺字段/非法盯梢级别/重复 id 各有定位', () => {
    // 缺 workspaceRoot
    expect(() => parseRuntimeConfig(baseYaml().replace('workspaceRoot: ./workspace\n', '')))
      .toThrow(/workspaceRoot 必须是非空字符串/);
    // 非法 supervision.level
    expect(() => parseRuntimeConfig(baseYaml().replace('level: shadow', "level: '自由'")))
      .toThrow(/supervision\.level 必须是 shadow\/assisted\/trusted 之一/);
    // 重复员工 id
    const dupYaml = `
profiles:
  - { id: emp-01, name: 小数, role: backend, skills: [backend] }
  - { id: emp-01, name: 小数2, role: test, skills: [test] }
routes:
  - callType: chat
    primary: { name: m, baseUrl: "http://x/v1", apiKey: k, model: glm }
workspaceRoot: ./workspace
sessionsRoot: ./sessions
`;
    expect(() => parseRuntimeConfig(dupYaml)).toThrow(/重复员工 id/);
    // skills 非法
    expect(() => parseRuntimeConfig(baseYaml().replace('skills: [backend, test]', 'skills: []')))
      .toThrow(/profiles\[0\]\.skills 必须是非空字符串数组/);
    // routes 为空/省略（2026-09-09 起允许：无模型集成模式——控制台/名册/Skill/MCP 管理全部可用，
    // 员工执行任务到模型调用时才暴露缺路由，归一为 []）
    expect(parseRuntimeConfig(baseYaml().replace(/routes:\n(  .*\n)+/, '')).routes).toEqual([]);
    // profiles 为空/省略（2026-09-09 起允许：纯管理台模式——员工全部由后台「数字员工」页手动添加）
    expect(parseRuntimeConfig(baseYaml().replace(/profiles:\n(  .*\n)+/, '')).profiles).toEqual([]);
    // 非法 callType
    expect(() => parseRuntimeConfig(baseYaml().replace('callType: chat', 'callType: chatx')))
      .toThrow(/callType 必须是 chat\/code\/review\/test 之一/);
    // 非法 tickIntervalMs
    expect(() => parseRuntimeConfig(baseYaml('tickIntervalMs: -1\n')))
      .toThrow(/tickIntervalMs 必须是正整数/);
    // yaml 语法错
    expect(() => parseRuntimeConfig('profiles: [unclosed')).toThrow(/yaml 解析失败/);
  });

  it('loadRuntimeConfig 从文件读取', () => {
    const cfg = loadRuntimeConfig(fileURLToPath(new URL('../../../examples/console-runtime.example.yaml', import.meta.url)));
    expect(cfg.profiles.map((p) => p.id)).toEqual(['emp-01', 'emp-02', 'emp-03']);
  });
});

describe('forge 段（代码托管协作：GitLab/Gitea，2026-09-05）', () => {
  it('缺省不注入；配置完整时 provider 归一化为 gitlab', () => {
    expect(parseRuntimeConfig(baseYaml()).forge).toBeUndefined();
    const cfg = parseRuntimeConfig(baseYaml('forge:\n  baseUrl: http://localhost:3000\n  token: pat-x\n'));
    expect(cfg.forge).toEqual({ provider: 'gitlab', baseUrl: 'http://localhost:3000', token: 'pat-x' });
  });

  it('gitea provider 透传；非法 provider 报错可读', () => {
    const cfg = parseRuntimeConfig(baseYaml('forge:\n  provider: gitea\n  baseUrl: http://localhost:3000\n  token: pat-x\n'));
    expect(cfg.forge).toEqual({ provider: 'gitea', baseUrl: 'http://localhost:3000', token: 'pat-x' });
    expect(() => parseRuntimeConfig(baseYaml('forge:\n  provider: svn\n  baseUrl: http://x\n  token: t\n')))
      .toThrow(/forge\.provider 必须是 gitlab\/gitea 之一/);
  });

  it('缺 token 报错可读；token 支持 enc:v1: 密文解密', () => {
    expect(() => parseRuntimeConfig(baseYaml('forge:\n  baseUrl: http://x\n')))
      .toThrow(/forge\.token 必须是非空字符串/);
    const cipher = encryptSecret('pat-secret', KEY);
    const cfg = parseRuntimeConfig(baseYaml(`forge:\n  provider: gitea\n  baseUrl: http://x\n  token: ${cipher}\n`));
    expect(resolveRuntimeSecrets(cfg, { DDW_CRED_KEY: KEY }).forge?.token).toBe('pat-secret');
  });
});

describe('deploy 段（发布部署，2026-09-05）', () => {
  it('deploy.envs 合法解析透传', () => {
    const cfg = parseRuntimeConfig(baseYaml(
      'deploy:\n  envs:\n    - name: test\n      artifactDir: /opt/ddw/web-app\n      restartCommand: "bash /opt/ddw/restart.sh"\n      artifactPath: dist\n      host: 127.0.0.1\n      user: root\n',
    ));
    expect(cfg.deploy?.envs).toEqual([
      { name: 'test', artifactDir: '/opt/ddw/web-app', restartCommand: 'bash /opt/ddw/restart.sh', artifactPath: 'dist', host: '127.0.0.1', user: 'root' },
    ]);
  });

  it('缺省不注入；name/artifactDir 缺失报错可读', () => {
    expect(parseRuntimeConfig(baseYaml()).deploy).toBeUndefined();
    expect(() => parseRuntimeConfig(baseYaml('deploy:\n  envs:\n    - artifactDir: /x\n')))
      .toThrow(/deploy\.envs\[0\]\.name 必须是非空字符串/);
    expect(() => parseRuntimeConfig(baseYaml('deploy:\n  envs:\n    - name: test\n')))
      .toThrow(/deploy\.envs\[0\]\.artifactDir 必须是非空字符串/);
    expect(() => parseRuntimeConfig(baseYaml('deploy:\n  envs: []\n')))
      .toThrow(/deploy\.envs 必须是非空数组/);
  });
});

describe('routes api 协议字段（双协议兼容，2026-09-05）', () => {
  // baseYaml 是追加语义，无法替换 routes 段——手写完整 yaml
  const yamlWithRoute = (route: string): string => `
profiles:
  - id: emp-01
    name: 小数
    role: backend
    skills: [backend]
routes:
${route}
workspaceRoot: ./workspace
sessionsRoot: ./sessions
`;

  it('api: anthropic-messages 合法且透传', () => {
    const cfg = parseRuntimeConfig(yamlWithRoute(
      "  - callType: chat\n    primary: { name: m, baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: k, model: glm-5.3-flash, api: anthropic-messages }",
    ));
    expect(cfg.routes[0]!.primary.api).toBe('anthropic-messages');
  });

  it('不写 api 缺省透传为 undefined（openai-completions 零回归）', () => {
    expect(parseRuntimeConfig(baseYaml()).routes[0]!.primary.api).toBeUndefined();
  });

  it('非法 api 值报错可读（primary / fallback 各有定位）', () => {
    expect(() => parseRuntimeConfig(yamlWithRoute(
      '  - callType: chat\n    primary: { name: m, baseUrl: "http://x/v1", apiKey: k, model: glm, api: anthropic }',
    ))).toThrow(/routes\[0\]\.primary\.api 必须是 openai-completions\/anthropic-messages 之一/);
    expect(() => parseRuntimeConfig(yamlWithRoute(
      '  - callType: chat\n    primary: { name: m, baseUrl: "http://x/v1", apiKey: k, model: glm }\n    fallback: { name: f, baseUrl: "http://x/v1", apiKey: k, model: glm2, api: gpt }',
    ))).toThrow(/routes\[0\]\.fallback\.api 必须是 openai-completions\/anthropic-messages 之一/);
  });

  it('fallback 形状校验：非对象 / 缺必填字段报错可读（fallback 收紧行为的覆盖）', () => {
    expect(() => parseRuntimeConfig(yamlWithRoute(
      '  - callType: chat\n    primary: { name: m, baseUrl: "http://x/v1", apiKey: k, model: glm }\n    fallback: gpt',
    ))).toThrow(/routes\[0\]\.fallback 必须是对象/);
    expect(() => parseRuntimeConfig(yamlWithRoute(
      '  - callType: chat\n    primary: { name: m, baseUrl: "http://x/v1", apiKey: k, model: glm }\n    fallback: { name: f, baseUrl: "http://x/v1", apiKey: k }',
    ))).toThrow(/routes\[0\]\.fallback\.model 必须是非空字符串/);
  });
});

describe('storage 段（存储企业化 Task 7：存储配置化）', () => {
  it('缺省不注入 storage（装配层取 DEFAULT_STORAGE = sqlite），既有 yaml 零回归', () => {
    expect(parseRuntimeConfig(baseYaml()).storage).toBeUndefined();
  });

  it('sqlite 段合法解析；path 可选透传', () => {
    expect(parseRuntimeConfig(baseYaml('storage: { driver: sqlite }\n')).storage).toEqual({ driver: 'sqlite' });
    expect(parseRuntimeConfig(baseYaml('storage:\n  driver: sqlite\n  sqlite:\n    path: /data/ddw.sqlite\n')).storage)
      .toEqual({ driver: 'sqlite', sqlite: { path: '/data/ddw.sqlite' } });
  });

  it('mysql 段合法解析：host/port/user/password/database 透传；password 支持 enc:v1: 密文原样透传（解密在装配层）', () => {
    const cfg = parseRuntimeConfig(baseYaml([
      'storage:',
      '  driver: mysql',
      '  mysql:',
      '    host: 127.0.0.1',
      '    port: 3307',
      '    user: ddw',
      "    password: 'enc:v1:aaa:bbb:ccc'",
      '    database: ddw_prod',
      '',
    ].join('\n')));
    expect(cfg.storage).toEqual({
      driver: 'mysql',
      mysql: { host: '127.0.0.1', port: 3307, user: 'ddw', password: 'enc:v1:aaa:bbb:ccc', database: 'ddw_prod' },
    });
  });

  it('枚举错可读：driver 必须 sqlite/mysql 之一', () => {
    expect(() => parseRuntimeConfig(baseYaml("storage: { driver: postgres }\n")))
      .toThrow(/storage\.driver 必须是 sqlite\/mysql 之一，得到 "postgres"/);
  });

  it('driver=mysql 缺 mysql 段报错可读', () => {
    expect(() => parseRuntimeConfig(baseYaml('storage: { driver: mysql }\n')))
      .toThrow(/storage\.mysql 必须是对象（driver=mysql 时必填 host\/user\/database）/);
  });

  it('driver=mysql 必填缺一报错可读（host/user/database 各有定位）', () => {
    expect(() => parseRuntimeConfig(baseYaml('storage: { driver: mysql, mysql: { user: ddw, database: d } }\n')))
      .toThrow(/storage\.mysql\.host 必须是非空字符串/);
    expect(() => parseRuntimeConfig(baseYaml('storage: { driver: mysql, mysql: { host: h, database: d } }\n')))
      .toThrow(/storage\.mysql\.user 必须是非空字符串/);
    expect(() => parseRuntimeConfig(baseYaml('storage: { driver: mysql, mysql: { host: h, user: ddw } }\n')))
      .toThrow(/storage\.mysql\.database 必须是非空字符串/);
    expect(() => parseRuntimeConfig(baseYaml('storage: { driver: mysql, mysql: { host: "", user: ddw, database: d } }\n')))
      .toThrow(/storage\.mysql\.host 必须是非空字符串/);
  });

  it('多余段交叉校验（T7 评审 P3）：driver 与段不匹配报错可读', () => {
    expect(() => parseRuntimeConfig(baseYaml('storage: { driver: sqlite, mysql: { host: h, user: u, database: d } }\n')))
      .toThrow(/storage\.driver 为 sqlite 时不应配置 mysql 段/);
    expect(() => parseRuntimeConfig(baseYaml('storage: { driver: mysql, sqlite: { path: /tmp/ddw.sqlite }, mysql: { host: h, user: u, database: d } }\n')))
      .toThrow(/storage\.driver 为 mysql 时不应配置 sqlite 段/);
  });

  it('非法形状报错可读：非对象 / port 非正整数 / password 非字符串', () => {
    expect(() => parseRuntimeConfig(baseYaml('storage: sqlite\n'))).toThrow(/storage 必须是对象/);
    expect(() => parseRuntimeConfig(baseYaml('storage: { driver: mysql, mysql: { host: h, user: u, database: d, port: 0 } }\n')))
      .toThrow(/storage\.mysql\.port 必须是正整数/);
    expect(() => parseRuntimeConfig(baseYaml('storage: { driver: mysql, mysql: { host: h, user: u, database: d, password: 123 } }\n')))
      .toThrow(/storage\.mysql\.password 必须是字符串/);
  });
});

describe('auth 段 + bindHost（2026-09-11 P0 安全批）', () => {
  it('缺省 = undefined（鉴权关闭、全网卡监听，零回归）', () => {
    const cfg = parseRuntimeConfig(baseYaml());
    expect(cfg.auth).toBeUndefined();
    expect(cfg.bindHost).toBeUndefined();
  });

  it('auth.tokens 合法解析 + bindHost 透传；token 支持 enc:v1: 密文解密', () => {
    const cipher = encryptSecret('tok-secret', KEY);
    const cfg = parseRuntimeConfig(baseYaml(
      `auth:\n  tokens:\n    - { name: 张三, token: ${cipher} }\n    - { name: 李四, token: plain-tok }\nbindHost: 127.0.0.1\n`,
    ));
    expect(cfg.auth).toEqual({ tokens: [{ name: '张三', token: cipher }, { name: '李四', token: 'plain-tok' }] });
    expect(cfg.bindHost).toBe('127.0.0.1');
    // resolveRuntimeSecrets 只解密不改变结构
    const resolved = resolveRuntimeSecrets(cfg, { DDW_CRED_KEY: KEY });
    expect(resolved.auth?.tokens[0]).toEqual({ name: '张三', token: 'tok-secret' });
    expect(resolved.auth?.tokens[1]).toEqual({ name: '李四', token: 'plain-tok' });
  });

  it('形状错误报错可读：非对象 / 空 tokens / name 或 token 空 / 重复 name / bindHost 空', () => {
    expect(() => parseRuntimeConfig(baseYaml('auth: sqlite\n'))).toThrow(/auth 必须是对象/);
    expect(() => parseRuntimeConfig(baseYaml('auth: { tokens: [] }\n'))).toThrow(/auth\.tokens 必须是非空数组/);
    expect(() => parseRuntimeConfig(baseYaml('auth:\n  tokens:\n    - { name: 张三 }\n')))
      .toThrow(/auth\.tokens\[0\]\.token 必须是非空字符串/);
    expect(() => parseRuntimeConfig(baseYaml('auth:\n  tokens:\n    - { name: 张三, token: t }\n    - { name: 张三, token: t2 }\n')))
      .toThrow(/重复的操作者名/);
    expect(() => parseRuntimeConfig(baseYaml("bindHost: ''\n"))).toThrow(/bindHost 必须是非空字符串/);
  });

  it('strictMode（2026-09-11 复盘批）：布尔透传，非布尔报可读错误', () => {
    expect(parseRuntimeConfig(baseYaml()).strictMode).toBeUndefined(); // 缺省关（零回归）
    expect(parseRuntimeConfig(baseYaml('strictMode: true\n')).strictMode).toBe(true);
    expect(parseRuntimeConfig(baseYaml('strictMode: false\n')).strictMode).toBe(false);
    expect(() => parseRuntimeConfig(baseYaml('strictMode: yes-but\n'))).toThrow(/strictMode 必须是布尔值/);
  });
});

describe('yanxun 段（2026-09-10 内部燕讯通知）', () => {
  const yxYaml = (extra = ''): string => `
yanxun:
  apiUrl: http://170.200.34.70:8199/api/message/sendRobotText
  requestHead:
    serviceCode: "50022000009"
    serviceScene: "11"
    lglBrId: "001"
    consumerId: "0251"
    orgConsumerId: "0251"
    channelTyp: "CH0540"
    filFlg: "0"
${extra}`;

  it('不配 = undefined；配置齐 = 解析为 YanxunConfig（isAtAll 缺省不带）', () => {
    expect(parseRuntimeConfig(baseYaml()).yanxun).toBeUndefined();
    const cfg = parseRuntimeConfig(baseYaml(yxYaml()));
    expect(cfg.yanxun).toEqual({
      apiUrl: 'http://170.200.34.70:8199/api/message/sendRobotText',
      head: { serviceCode: '50022000009', serviceScene: '11', lglBrId: '001', consumerId: '0251', orgConsumerId: '0251', channelTyp: 'CH0540', filFlg: '0' },
    });
    // isAtAll: true → 带上；false/缺省不带（报文侧归 '0'）
    expect(parseRuntimeConfig(baseYaml(yxYaml('  isAtAll: true\n'))).yanxun?.isAtAll).toBe(true);
    expect(parseRuntimeConfig(baseYaml(yxYaml('  isAtAll: false\n'))).yanxun).not.toHaveProperty('isAtAll');
  });

  it('非法形状报错可读：非对象 / apiUrl 非 http(s) / requestHead 缺字段 / isAtAll 非布尔', () => {
    expect(() => parseRuntimeConfig(baseYaml('yanxun: sqlite\n'))).toThrow(/yanxun 必须是对象/);
    expect(() => parseRuntimeConfig(baseYaml('yanxun: { apiUrl: ftp://x, requestHead: { serviceCode: "1", serviceScene: "1", lglBrId: "1", consumerId: "1", orgConsumerId: "1", channelTyp: "1", filFlg: "0" } }\n')))
      .toThrow(/yanxun\.apiUrl 必须是 http/);
    expect(() => parseRuntimeConfig(baseYaml(yxYaml().replace('    channelTyp: "CH0540"\n', ''))))
      .toThrow(/yanxun\.requestHead\.channelTyp 必须是非空字符串/);
    expect(() => parseRuntimeConfig(baseYaml(yxYaml('  isAtAll: "yes"\n')))).toThrow(/yanxun\.isAtAll 必须是布尔值/);
  });
});

describe('retention 段（磁盘治理，2026-09-11 P1 治理批）', () => {
  it('workspaceDays 非负整数透传；段缺省 = 不启用', () => {
    expect(parseRuntimeConfig(baseYaml('retention:\n  workspaceDays: 7\n')).retention).toEqual({ workspaceDays: 7 });
    expect(parseRuntimeConfig(baseYaml('retention:\n  workspaceDays: 0\n')).retention).toEqual({ workspaceDays: 0 });
    expect(parseRuntimeConfig(baseYaml()).retention).toBeUndefined();
  });

  it('段存在但缺 workspaceDays / 非法值 → 可读报错', () => {
    expect(() => parseRuntimeConfig(baseYaml('retention: {}\n'))).toThrow(/retention.workspaceDays 必须是非负整数/);
    expect(() => parseRuntimeConfig(baseYaml('retention:\n  workspaceDays: -1\n'))).toThrow(/retention.workspaceDays 必须是非负整数/);
    expect(() => parseRuntimeConfig(baseYaml("retention:\n  workspaceDays: '7d'\n"))).toThrow(/retention.workspaceDays 必须是非负整数/);
  });
});

describe('storage.mysql.connectionLimit（连接池上限，2026-09-11 P1 治理批）', () => {
  const mysqlYaml = (over = ''): string => `
storage:
  driver: mysql
  mysql:
    host: 127.0.0.1
    user: ddw
    database: ddw
${over}
`;
  it('正整数透传；缺省 undefined（驱动缺省 10）', () => {
    expect(parseRuntimeConfig(baseYaml(mysqlYaml('    connectionLimit: 20\n'))).storage?.mysql?.connectionLimit).toBe(20);
    expect(parseRuntimeConfig(baseYaml(mysqlYaml())).storage?.mysql?.connectionLimit).toBeUndefined();
  });

  it('非正整数/非整数 → 可读报错', () => {
    expect(() => parseRuntimeConfig(baseYaml(mysqlYaml('    connectionLimit: 0\n')))).toThrow(/storage.mysql.connectionLimit 必须是正整数/);
    expect(() => parseRuntimeConfig(baseYaml(mysqlYaml('    connectionLimit: 2.5\n')))).toThrow(/storage.mysql.connectionLimit 必须是正整数/);
  });
});
