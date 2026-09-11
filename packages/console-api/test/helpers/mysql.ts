import { createMysqlDriver } from '../../src/stores/sql/mysql-driver.js';

export const MYSQL_TEST_DB = 'ddw_test';

/**
 * 测试库名强制改写（URL 解析重写，防 DDW_TEST_MYSQL_URL 误指生产库误写）。
 * 缺省 ddw_test；各测试文件传自己的后缀库名（vitest 多文件并行，同库会互相 DROP/清表踩踏）。
 * 查询串（charset 等）原样保留。
 */
export function mysqlTestUrl(rawUrl: string, db: string = MYSQL_TEST_DB): string {
  const u = new URL(rawUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

/** 无库名管理连接 url（DROP/CREATE DATABASE 需要未选定库的连接） */
function adminUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  u.pathname = '';
  return u.toString();
}

/**
 * 测试库隔离：DROP DATABASE IF EXISTS <db> → CREATE DATABASE <db>。
 * beforeAll 每组调一次；表数据即弃，库保留。凭据只经 env 注入，绝不写入任何文件。
 */
export async function resetMysqlTestDb(rawUrl: string, db: string = MYSQL_TEST_DB): Promise<void> {
  const admin = await createMysqlDriver(adminUrl(rawUrl));
  try {
    await admin.exec(`DROP DATABASE IF EXISTS ${db}`);
    await admin.exec(`CREATE DATABASE ${db} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await admin.close();
  }
}
