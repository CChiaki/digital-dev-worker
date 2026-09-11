import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks, formatChecks, isCiphertextConfig } from '../src/doctor.js';
import { SqliteDriver } from '../src/stores/sql/sqlite-driver.js';
import { SqlEventStore } from '../src/stores/sql/sql-event-store.js';
import { GENESIS_HASH, canonicalContent, computeHash } from '../src/stores/hash-chain.js';
import { generateMasterKey, encryptSecret, MASTER_KEY_ENV } from '../src/team/credentials.js';

/**
 * P11-T2 交付巡检（doctor）：检查项注入式可测（不监听端口、不依赖真实集群）；
 * 全绿路径 / 各失败路径 / 报告格式。
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ddw-doctor-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = (over: Partial<Parameters<typeof runChecks>[0]> = {}) => ({
  dataDir: dir,
  nodeVersion: '22.10.0',
  which: async () => true,
  env: {},
  ...over,
});

describe('doctor 巡检', () => {
  it('全绿路径：空目录首次运行，各项通过', async () => {
    const results = await runChecks(base());
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.name)).toEqual(['Node 版本', '数据目录可写', '存储与审计 hash 链', 'bash 白名单命令']);
  });

  it('Node 版本过低 / 白名单命令缺失：失败项明细可读', async () => {
    const results = await runChecks(base({
      nodeVersion: '18.2.0',
      which: async (cmd) => cmd !== 'python3',
    }));
    const node = results.find((r) => r.name === 'Node 版本')!;
    const bash = results.find((r) => r.name === 'bash 白名单命令')!;
    expect(node.ok).toBe(false);
    expect(node.detail).toContain('≥ 20.5');
    expect(bash.ok).toBe(false);
    expect(bash.detail).toContain('python3');
    expect(results.every((r) => r.ok)).toBe(false);
  });

  it('存储检查：sqlite 存在时校验审计链——成链完整 ok，篡改可检测', async () => {
    // 先造一个成链完整的 sqlite 数据目录
    const driver = new SqliteDriver(join(dir, 'ddw.sqlite'));
    await driver.ensureSchema();
    const store = new SqlEventStore(driver);
    await store.append({ id: 'e1', ts: 1, taskId: 'T', employeeId: 'e', type: 'report', summary: 's1' });
    await store.append({ id: 'e2', ts: 2, taskId: 'T', employeeId: 'e', type: 'report', summary: 's2' });
    await driver.close();

    const okResults = await runChecks(base());
    const okStorage = okResults.find((r) => r.name === '存储与审计 hash 链')!;
    expect(okStorage.ok).toBe(true);
    expect(okStorage.detail).toContain('2 条事件');

    // 篡改：直接改库内 summary（hash 链校验应暴露）
    const db = new DatabaseSync(join(dir, 'ddw.sqlite'));
    db.exec(`UPDATE ddw_events SET summary = '篡改' WHERE id = 'e1'`);
    db.close();
    const badResults = await runChecks(base());
    expect(badResults.find((r) => r.name === '存储与审计 hash 链')!.ok).toBe(false);
  });

  it('runtime yaml：解析+凭据解密成功为绿；密文缺主密钥为红', async () => {
    const key = generateMasterKey();
    const yaml = `
profiles: [{ id: emp-01, name: 小数, role: backend, skills: [backend] }]
workspaceRoot: ./ws
sessionsRoot: ./sessions
auth:
  tokens:
    - { name: 张三, token: "${encryptSecret('tok-x', key)}" }
routes:
  - callType: code
    primary: { baseUrl: http://m/v1, apiKey: "${encryptSecret('real-key', key)}", model: glm }
`;
    const yamlPath = join(dir, 'runtime.yaml');
    await writeFile(yamlPath, yaml, 'utf8');

    const okResults = await runChecks(base({
      runtimePath: yamlPath,
      env: { [MASTER_KEY_ENV]: key },
      probe: true,
      probeModels: async () => undefined,
    }));
    expect(okResults.find((r) => r.name === '运行时配置与凭据')!.ok).toBe(true);
    expect(okResults.find((r) => r.name === '运行时配置与凭据')!.detail).toContain('凭据解密成功');
    expect(okResults.find((r) => r.name === `主密钥（${MASTER_KEY_ENV}）`)!.ok).toBe(true);
    expect(okResults.find((r) => r.name === '模型集群连通')!.ok).toBe(true);
    // 2026-09-11 P0 安全批新增巡检：全合规 yaml（含 auth 段 + 全密文凭据）不得误报
    expect(okResults.find((r) => r.name === '敏感凭据密文化')!.ok).toBe(true);
    expect(okResults.find((r) => r.name === 'API 鉴权')!.ok).toBe(true);
    expect(okResults.find((r) => r.name === 'API 鉴权')!.detail).toContain('1 个具名 token');
    expect(okResults.every((r) => r.ok)).toBe(true);

    // 缺主密钥：配置项红
    const badResults = await runChecks(base({ runtimePath: yamlPath, env: {} }));
    expect(badResults.find((r) => r.name === '运行时配置与凭据')!.ok).toBe(false);
    expect(badResults.find((r) => r.name === `主密钥（${MASTER_KEY_ENV}）`)!.ok).toBe(false);
    // 密文化/鉴权两项只看字段形状（enc:v1: 前缀 / auth 段存在），与主密钥是否在场无关
    expect(badResults.find((r) => r.name === '敏感凭据密文化')!.ok).toBe(true);
    expect(badResults.find((r) => r.name === 'API 鉴权')!.ok).toBe(true);
  });

  it('明文凭据时主密钥不阻塞（P15：样例明文 yaml 误判红的修复）', async () => {
    const yamlPath = join(dir, 'runtime.yaml');
    await writeFile(yamlPath, `
profiles: [{ id: emp-01, name: 小数, role: backend, skills: [backend] }]
workspaceRoot: ./ws
sessionsRoot: ./sessions
routes:
  - callType: code
    primary: { baseUrl: http://m/v1, apiKey: plain-key, model: glm }
`, 'utf8');
    const results = await runChecks(base({ runtimePath: yamlPath, env: {} }));
    const keyResult = results.find((r) => r.name === `主密钥（${MASTER_KEY_ENV}）`)!;
    expect(keyResult.ok).toBe(true);
    expect(keyResult.detail).toContain('不阻塞');
    // 2026-09-11 P0 安全批：明文凭据与未配鉴权由专项巡检标红（主密钥不阻塞 ≠ 全绿）
    const plain = results.find((r) => r.name === '敏感凭据密文化')!;
    expect(plain.ok).toBe(false);
    expect(plain.detail).toContain('routes[0].primary.apiKey');
    expect(results.find((r) => r.name === 'API 鉴权')!.ok).toBe(false);
  });

  it('isCiphertextConfig：apiKey/password 两种字段任一密文即命中；明文/注释/占位符不误判', () => {
    // 仅 storage.mysql.password 密文（apiKey 明文）——终审 P2 修复口径
    expect(isCiphertextConfig('storage:\n  mysql:\n    password: enc:v1:abc,other\n    user: root\n')).toBe(true);
    expect(isCiphertextConfig('routes:\n  - primary: { apiKey: "enc:v1:xyz" }\n')).toBe(true);
    expect(isCiphertextConfig('routes:\n  - primary: { apiKey: plain-key }\nstorage:\n  mysql:\n    password: plain-pw\n')).toBe(false);
    // 注释与占位符不算（P15 口径）
    expect(isCiphertextConfig('# password: enc:v1:sample\napiKey: your-key-here\n')).toBe(false);
  });

  it('probe 探测失败：网络不可达明细可读；未配 runtime 时提示', async () => {
    const failResults = await runChecks(base({
      probe: true,
      probeModels: async () => { throw new Error('连接超时（5s）'); },
    }));
    expect(failResults.find((r) => r.name === '模型集群连通')!.ok).toBe(false);
    expect(failResults.find((r) => r.name === '模型集群连通')!.detail).toContain('--runtime');

    const yamlPath = join(dir, 'runtime.yaml');
    await writeFile(yamlPath, `
profiles: [{ id: emp-01, name: 小数, role: backend, skills: [backend] }]
workspaceRoot: ./ws
sessionsRoot: ./sessions
routes:
  - callType: code
    primary: { baseUrl: http://m/v1, apiKey: plain, model: glm }
`, 'utf8');
    const netResults = await runChecks(base({
      runtimePath: yamlPath,
      probe: true,
      probeModels: async () => { throw new Error('connect EHOSTUNREACH'); },
    }));
    const probeResult = netResults.find((r) => r.name === '模型集群连通')!;
    expect(probeResult.ok).toBe(false);
    expect(probeResult.detail).toContain('EHOSTUNREACH');
  });

  it('formatChecks：✓/✗ 对齐报告', async () => {
    const results = await runChecks(base({ nodeVersion: '18.0.0' }));
    const text = formatChecks(results);
    expect(text).toContain('✓');
    expect(text).toContain('✗');
    expect(text.split('\n')).toHaveLength(results.length);
  });

  // ---- 存储连通（存储企业化 Task 8）：注入 storage 段才输出；缺省行为不变（上面的 4 项用例覆盖） ----

  it('存储连通 sqlite：目标路径目录可写为绿；不可写为红', async () => {
    const custom = join(dir, 'custom', 'ddw.sqlite');
    const okResults = await runChecks(base({ storage: { driver: 'sqlite', sqlite: { path: custom } } }));
    const ok = okResults.find((r) => r.name === '存储连通')!;
    expect(ok.ok).toBe(true);
    expect(ok.detail).toContain('custom');
    expect(ok.detail).toContain('目录可写');
    // 库文件未建时注明首启创建
    expect(ok.detail).toContain('首次启动自动创建');

    // 路径父级是文件 → 目录建不出来 → 红
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x', 'utf8');
    const badResults = await runChecks(base({
      storage: { driver: 'sqlite', sqlite: { path: join(blocker, 'sub', 'ddw.sqlite') } },
    }));
    const bad = badResults.find((r) => r.name === '存储连通')!;
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('不可写');
  });

  it('存储连通：未提供 storage 段时不输出该巡检项（缺省 sqlite 行为不变）', async () => {
    const results = await runChecks(base());
    expect(results.find((r) => r.name === '存储连通')).toBeUndefined();
  });

  it('存储连通：yaml 只有 storage 段（迁移场景）也能单取该段巡检', async () => {
    const yamlPath = join(dir, 'migrate-runtime.yaml');
    await writeFile(yamlPath, `
storage:
  driver: sqlite
  sqlite:
    path: ${join(dir, 'target.sqlite')}
`, 'utf8');
    const results = await runChecks(base({ runtimePath: yamlPath }));
    const check = results.find((r) => r.name === '存储连通')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('target.sqlite');
    // 完整 runtime 配置项仍然红（无 profiles/routes），但 storage 巡检独立可用
    expect(results.find((r) => r.name === '运行时配置与凭据')!.ok).toBe(false);
  });

  it('存储与审计链：旧 sqlite 存量库（task/event 单数表）按旧链校验不误报', async () => {
    const db = new DatabaseSync(join(dir, 'ddw.sqlite'));
    db.exec(`
      CREATE TABLE task (id TEXT PRIMARY KEY, pkg TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE event (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        ts INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT,
        prev_hash TEXT,
        hash TEXT
      );
    `);
    // 成链两条（与 T3 hash 链同算法）
    let prev = GENESIS_HASH;
    for (const e of [
      { id: 'l1', ts: 1, summary: 's1' },
      { id: 'l2', ts: 2, summary: 's2' },
    ]) {
      const hash = computeHash(canonicalContent({ id: e.id, ts: e.ts, taskId: 'T', employeeId: 'e', type: 'report', summary: e.summary, payload: null } as never, 1), prev);
      db.prepare('INSERT INTO event (id, ts, task_id, employee_id, type, summary, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(e.id, e.ts, 'T', 'e', 'report', e.summary, prev, hash);
      prev = hash;
    }
    db.close();

    const results = await runChecks(base());
    const storage = results.find((r) => r.name === '存储与审计 hash 链')!;
    expect(storage.ok).toBe(true);
    expect(storage.detail).toContain('旧表 event');
    expect(storage.detail).toContain('2 条事件');

    // 篡改旧表 → 仍可检测
    const raw = new DatabaseSync(join(dir, 'ddw.sqlite'));
    raw.exec("UPDATE event SET summary = '篡改' WHERE id = 'l1'");
    raw.close();
    const bad = (await runChecks(base())).find((r) => r.name === '存储与审计 hash 链')!;
    expect(bad.ok).toBe(false);
  });
});

// mysql 存储连通（env 开关，离线安全）：注入 DDW_TEST_MYSQL_URL 才真跑
const mysqlUrl = process.env.DDW_TEST_MYSQL_URL;
const dmysql = mysqlUrl ? describe : describe.skip;

dmysql('doctor 存储连通 mysql（DDW_TEST_MYSQL_URL）', () => {
  it('连接 + 库存在 + ddw_ 表清单；空库提示「首次启动自动建表」不算失败', async () => {
    const u = new URL(mysqlUrl!);
    const storage = {
      driver: 'mysql' as const,
      mysql: {
        host: u.hostname, port: u.port ? Number(u.port) : 3306,
        user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
        database: 'ddw_doctor_probe',
      },
    };
    // 建一个确定存在的空库（只动 ddw_doctor_probe，不碰其他库）
    const admin = new URL(mysqlUrl!); admin.pathname = '';
    const { createMysqlDriver } = await import('../src/stores/sql/mysql-driver.js');
    const adm = await createMysqlDriver(admin.toString());
    await adm.exec('DROP DATABASE IF EXISTS ddw_doctor_probe');
    await adm.exec('CREATE DATABASE ddw_doctor_probe CHARACTER SET utf8mb4');
    await adm.close();

    const results = await runChecks(base({ storage }));
    const check = results.find((r) => r.name === '存储连通')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('空库，首次启动自动建表');

    // 库不存在 → 红
    const missing = await runChecks(base({
      storage: { ...storage, mysql: { ...storage.mysql, database: 'ddw_no_such_db_xx' } },
    }));
    expect(missing.find((r) => r.name === '存储连通')!.ok).toBe(false);

    // 清理探针库
    const adm2 = await createMysqlDriver(admin.toString());
    await adm2.exec('DROP DATABASE IF EXISTS ddw_doctor_probe');
    await adm2.close();
  });
});

describe('doctor 员工模型密钥密文化巡检（2026-09-11 复盘批）', () => {
  it('员工表未建跳过 / 明文报红提示迁移 / 全密文通过', async () => {
    const storage = { driver: 'sqlite' as const, sqlite: { path: join(dir, 'ddw.sqlite') } };
    // 库未创建 = 首次运行跳过（ok）
    const first = await runChecks(base({ storage }));
    expect(first.find((r) => r.name === '员工模型密钥密文化')!.ok).toBe(true);

    // 种子：一条明文 + 一条密文
    const driver = new SqliteDriver(join(dir, 'ddw.sqlite'));
    await driver.ensureSchema();
    const mkDoc = (apiKey: string): string =>
      JSON.stringify({ id: 'emp-1', roles: ['后端'], capabilities: [], enabled: true, model: { baseUrl: 'u', apiKey, model: 'm' } });
    await driver.run('INSERT INTO ddw_employees (id, doc, updated_at, enabled) VALUES (?, ?, ?, ?)', ['emp-1', mkDoc('sk-plain'), Date.now(), 1]);
    await driver.run('INSERT INTO ddw_employees (id, doc, updated_at, enabled) VALUES (?, ?, ?, ?)', ['emp-2', mkDoc('enc:v1:a:b:c'), Date.now(), 1]);
    await driver.close();

    const mixed = await runChecks(base({ storage }));
    const bad = mixed.find((r) => r.name === '员工模型密钥密文化')!;
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('emp-1');
    expect(bad.detail).not.toContain('emp-2'); // 密文条目不计入
    expect(bad.detail).toContain('DDW_CRED_KEY');

    // 明文翻写密文后 → 绿
    const driver2 = new SqliteDriver(join(dir, 'ddw.sqlite'));
    await driver2.run('UPDATE ddw_employees SET doc = ? WHERE id = ?', [mkDoc('enc:v1:x:y:z'), 'emp-1']);
    await driver2.close();
    const clean = await runChecks(base({ storage }));
    expect(clean.find((r) => r.name === '员工模型密钥密文化')!.ok).toBe(true);
  });
});
