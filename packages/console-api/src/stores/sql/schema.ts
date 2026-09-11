/**
 * 双方言 10 表 DDL（存储企业化 spec §5：窄列 + doc JSON；2026-09-10 增 ddw_generations 智能生成记录表
 * 与 ddw_push_logs 推送留痕表）。
 * sqlite：TEXT 列 + INTEGER 自增；mysql：VARCHAR/BIGINT + JSON 列 + BIGINT AUTO_INCREMENT。
 * 业务 JSON（pkg/result/doc/payload）统一经 SqlDriver.encodeJson（JSON.stringify）存字符串，
 * TEXT / JSON 列均可存字符串字面量。
 */
export const DDL: { sqlite: string[]; mysql: string[] } = {
  sqlite: [
    `CREATE TABLE IF NOT EXISTS ddw_tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0,
      pkg TEXT NOT NULL,
      result TEXT,
      plan_progress TEXT,
      failed_item_id TEXT,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ddw_tasks_status ON ddw_tasks(status)`,
    `CREATE TABLE IF NOT EXISTS ddw_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      ts INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT,
      prev_hash TEXT,
      hash TEXT,
      hash_version INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ddw_events_task_id ON ddw_events(task_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ddw_events_employee_id ON ddw_events(employee_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ddw_events_type ON ddw_events(type)`,
    `CREATE INDEX IF NOT EXISTS idx_ddw_events_ts ON ddw_events(ts)`,
    `CREATE TABLE IF NOT EXISTS ddw_employees (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      doc TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ddw_employees_enabled ON ddw_employees(enabled)`,
    `CREATE TABLE IF NOT EXISTS ddw_skill_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      doc TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ddw_skills (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL,
      status TEXT NOT NULL,
      doc TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ddw_skills_category_id ON ddw_skills(category_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ddw_skills_status ON ddw_skills(status)`,
    `CREATE TABLE IF NOT EXISTS ddw_capabilities (
      kind TEXT PRIMARY KEY,
      doc TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ddw_messages (
      id TEXT PRIMARY KEY,
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      doc TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ddw_messages_read ON ddw_messages(read)`,
    `CREATE INDEX IF NOT EXISTS idx_ddw_messages_created_at ON ddw_messages(created_at)`,
    `CREATE TABLE IF NOT EXISTS ddw_channels (
      id TEXT PRIMARY KEY,
      doc TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ddw_generations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      doc TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ddw_generations_created_at ON ddw_generations(created_at)`,
    // 推送留痕（2026-09-10）：消息 × 渠道推送结果（sent/failed + 燕讯 seqNo）
    `CREATE TABLE IF NOT EXISTS ddw_push_logs (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      doc TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ddw_push_logs_created_at ON ddw_push_logs(created_at)`,
  ],
  mysql: [
    `CREATE TABLE IF NOT EXISTS ddw_tasks (
      id VARCHAR(64) PRIMARY KEY,
      status VARCHAR(32) NOT NULL,
      claimed_by VARCHAR(64) NULL,
      claimed_at BIGINT NULL,
      created_at BIGINT NOT NULL DEFAULT 0,
      pkg JSON NOT NULL,
      result JSON NULL,
      plan_progress JSON NULL,
      failed_item_id VARCHAR(64) NULL,
      updated_at BIGINT NOT NULL,
      INDEX idx_ddw_tasks_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ddw_events (
      seq BIGINT AUTO_INCREMENT PRIMARY KEY,
      id VARCHAR(64) NOT NULL UNIQUE,
      ts BIGINT NOT NULL,
      task_id VARCHAR(64) NOT NULL,
      employee_id VARCHAR(64) NOT NULL,
      type VARCHAR(64) NOT NULL,
      summary TEXT NOT NULL,
      payload JSON NULL,
      prev_hash VARCHAR(128) NULL,
      hash VARCHAR(128) NULL,
      hash_version INT NOT NULL DEFAULT 1,
      INDEX idx_ddw_events_task_id (task_id),
      INDEX idx_ddw_events_employee_id (employee_id),
      INDEX idx_ddw_events_type (type),
      INDEX idx_ddw_events_ts (ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ddw_employees (
      id VARCHAR(64) PRIMARY KEY,
      enabled TINYINT NOT NULL DEFAULT 1,
      doc JSON NOT NULL,
      updated_at BIGINT NOT NULL,
      INDEX idx_ddw_employees_enabled (enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ddw_skill_categories (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      doc JSON NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ddw_skills (
      id VARCHAR(64) PRIMARY KEY,
      category_id VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL,
      doc JSON NOT NULL,
      INDEX idx_ddw_skills_category_id (category_id),
      INDEX idx_ddw_skills_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ddw_capabilities (
      kind VARCHAR(64) PRIMARY KEY,
      doc JSON NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ddw_messages (
      id VARCHAR(64) PRIMARY KEY,
      \`read\` TINYINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      doc JSON NOT NULL,
      INDEX idx_ddw_messages_read (\`read\`),
      INDEX idx_ddw_messages_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ddw_channels (
      id VARCHAR(64) PRIMARY KEY,
      doc JSON NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ddw_generations (
      id VARCHAR(64) PRIMARY KEY,
      created_at BIGINT NOT NULL,
      doc JSON NOT NULL,
      INDEX idx_ddw_generations_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // 推送留痕（2026-09-10）：消息 × 渠道推送结果（sent/failed + 燕讯 seqNo）
    `CREATE TABLE IF NOT EXISTS ddw_push_logs (
      id VARCHAR(64) PRIMARY KEY,
      created_at BIGINT NOT NULL,
      doc JSON NOT NULL,
      INDEX idx_ddw_push_logs_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
};

/**
 * 存量库轻量列迁移（2026-09-11 P1 治理批）：CREATE TABLE IF NOT EXISTS 对已建表不生效，
 * 新增列靠各驱动 ensureSchema 探测（sqlite PRAGMA table_info / mysql information_schema）
 * 后 ALTER TABLE ADD COLUMN 幂等补列。backfill 仅在补列当次执行（新建表列默认 0，
 * add() 恒显式写 created_at，WHERE created_at = 0 只命中迁移前的存量行）。
 */
export const COLUMN_MIGRATIONS: {
  table: string;
  column: string;
  /** 方言列定义（含 NOT NULL/DEFAULT），拼进 ALTER TABLE ADD COLUMN */
  sqlite: string;
  mysql: string;
  /** 补列后一次性回填（可选）：旧行近似值 */
  backfill?: string;
}[] = [
  {
    table: 'ddw_tasks',
    column: 'created_at',
    sqlite: 'INTEGER NOT NULL DEFAULT 0',
    mysql: 'BIGINT NOT NULL DEFAULT 0',
    // 旧行以 updated_at 近似（最后更新时间 ≥ 创建时间的合理代理；0 会把全部旧任务永排最前）
    backfill: 'UPDATE ddw_tasks SET created_at = updated_at WHERE created_at = 0',
  },
];
