/**
 * 测试用数据库夹具。
 *
 * 干什么: 在开发库里建一个本测试独占的临时 schema,重放全部迁移 SQL,
 *         建一个绑定到该 schema 的 PrismaClient 返回给测试;结束时断开并 DROP SCHEMA。
 * 解决什么问题: 让「单元测试直接连真数据库」在"只有 schema 权限、没有 CREATEDB"的
 *         共享 PG 上同样成立(沙箱就是这个权限模型)。
 *
 * [隔离] 每个测试文件拿到的是**自己的 schema**。连接的 search_path 只指向它,
 *   Prisma 生成的查询也带它的前缀,测试之间看不见对方的表,可以放心并行跑;
 *   清理只需要 DROP SCHEMA ... CASCADE 一条语句。
 *
 * [为什么直接执行迁移 SQL 而不是每次调 prisma CLI] CLI 冷启动要好几秒,几百个用例就是
 *   十几分钟,TDD 的反馈循环直接废掉。迁移 SQL 本身不写死 schema
 *   (tests/migrations-schema-agnostic.test.ts 守着),在 search_path 下执行即可落进临时 schema。
 *   "prisma migrate deploy 能落进指定 schema"这条上线路径,由 global-setup 每次真跑一遍兜住。
 *
 * 用法:
 * ```ts
 * const db = await setupTestDb();
 * afterAll(() => db.cleanup());
 * // db.prisma 就是一个连着干净空 schema 的真 PrismaClient
 * ```
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { createPrismaClient } from '../../src/platform/db/prisma-client.js';
import type { PrismaClient } from '../../src/platform/db/prisma.js';
import { SCHEMA_PREFIX_ENV, TEST_DATABASE_URL_ENV } from './global-setup.js';

export interface TestDb {
  prisma: PrismaClient;
  /** 本次测试独占的 schema 名,断言失败时打出来便于人工去库里看。 */
  schema: string;
  /** 数据库连接串(不含 schema;schema 由 createPrismaClient 的 schema 选项决定)。 */
  connectionString: string;
  cleanup: () => Promise<void>;
}

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');

/** 按目录名(时间戳前缀)排序的全部迁移 SQL,与 migrate deploy 的执行顺序一致。 */
const loadMigrations = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((name) => statSync(resolve(MIGRATIONS_DIR, name)).isDirectory())
    .sort()
    .map((name) => readFileSync(resolve(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));

let migrations: string[] | undefined;

export const setupTestDb = async (): Promise<TestDb> => {
  const prefix = process.env[SCHEMA_PREFIX_ENV];
  const connectionString = process.env[TEST_DATABASE_URL_ENV];

  if (prefix === undefined || connectionString === undefined) {
    throw new Error(
      `缺少测试库信息(${SCHEMA_PREFIX_ENV} / ${TEST_DATABASE_URL_ENV})。` +
        '检查 vitest.config.ts 是否配了 globalSetup。',
    );
  }

  // schema 名带随机后缀 —— 同一个测试文件里多次 setupTestDb 也不会撞,
  // 并行跑的多个文件之间更不会。前缀带 pid,teardown 靠它批量清理。
  const schema = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  migrations ??= loadMigrations();

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    for (const sql of migrations) {
      await client.query(sql);
    }
  } finally {
    await client.end();
  }

  // 池子给小一点: 每个测试文件一个 schema,并发量很低,
  // 开大只会让并行跑测试时把 PG 的连接数打满(PG 默认 max_connections=100)。
  const prisma = await createPrismaClient({ connectionString, schema, poolMax: 3 });

  return {
    prisma,
    schema,
    connectionString,
    cleanup: async (): Promise<void> => {
      await prisma.$disconnect();
      const dropper = new Client({ connectionString });
      await dropper.connect();
      try {
        await dropper.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await dropper.end();
      }
    },
  };
};
