/**
 * 测试用数据库夹具。
 *
 * 干什么: 从 globalSetup 建好的模板库克隆一份独立数据库,建连接返回给测试用;
 *         结束时断开并删掉克隆。
 * 解决什么问题: 让「单元测试直接连真数据库」这件事在成本上可行 ——
 *         `CREATE DATABASE ... TEMPLATE` 是 PG 在数据目录里直接复制文件,
 *         不重放任何 DDL,几十毫秒级别。
 *
 * [隔离] 每个测试文件拿到的是**自己的 database**,不是共享库里的一个 schema。
 *   库级隔离意味着测试之间连"看见对方的表"都做不到,可以放心并行跑;
 *   而且清理只需要 DROP DATABASE 一条语句,不会留下脏数据影响下一个用例。
 *
 * 用法:
 * ```ts
 * const db = await setupTestDb();
 * afterAll(() => db.cleanup());
 * // db.prisma 就是一个连着干净空库的真 PrismaClient
 * ```
 */

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createPrismaClient } from '../../src/infrastructure/persistence/postgres/prisma-client.js';
import type { PrismaClient } from '../../src/infrastructure/persistence/postgres/prisma.js';
import { ADMIN_URL_ENV, TEMPLATE_DB_ENV, withDatabase } from './global-setup.js';

export interface TestDb {
  prisma: PrismaClient;
  /** 本次测试独占的数据库名,断言失败时打出来便于人工去库里看。 */
  databaseName: string;
  connectionString: string;
  cleanup: () => Promise<void>;
}

const runOnMaintenanceDb = async (baseUrl: string, sql: string): Promise<void> => {
  const client = new Client({ connectionString: withDatabase(baseUrl, 'postgres') });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
};

export const setupTestDb = async (): Promise<TestDb> => {
  const templateName = process.env[TEMPLATE_DB_ENV];
  const baseUrl = process.env[ADMIN_URL_ENV];

  if (templateName === undefined || baseUrl === undefined) {
    throw new Error(
      `缺少模板库信息(${TEMPLATE_DB_ENV} / ${ADMIN_URL_ENV})。` +
        '检查 vitest.config.ts 是否配了 globalSetup。',
    );
  }

  // 库名带随机后缀 —— 同一个测试文件里多次 setupTestDb 也不会撞,
  // 并行跑的多个文件之间更不会。前缀统一是 keel_test_,teardown 靠它批量清理。
  const databaseName = `keel_test_${randomUUID().replace(/-/g, '')}`;

  await runOnMaintenanceDb(
    baseUrl,
    `CREATE DATABASE "${databaseName}" TEMPLATE "${templateName}"`,
  );

  const connectionString = withDatabase(baseUrl, databaseName);
  // 池子给小一点: 每个测试文件一个库,并发量很低,
  // 开大只会让并行跑测试时把 PG 的连接数打满(PG 默认 max_connections=100)。
  const prisma = await createPrismaClient({ connectionString, poolMax: 3 });

  return {
    prisma,
    databaseName,
    connectionString,
    cleanup: async (): Promise<void> => {
      // 必须先断开自己的连接,否则 DROP DATABASE 会报"正在被访问"
      await prisma.$disconnect();
      await runOnMaintenanceDb(baseUrl, `DROP DATABASE IF EXISTS "${databaseName}"`);
    },
  };
};
