/**
 * vitest 全局前置 —— 为本次测试运行划一个 schema 前缀,并验证迁移能落进指定 schema。
 *
 * 干什么:
 *   1. 生成本次运行的 schema 前缀(带 pid),各测试文件在它下面建自己的临时 schema;
 *   2. 用真实的 `prisma migrate deploy` 把迁移跑进一个探针 schema —— 这正是沙箱里
 *      "共享 PG + DATABASE_SCHEMA" 的上线路径,每次跑测试都真实执行一遍;
 *   3. teardown 时按前缀删掉本次运行留下的全部 schema。
 *
 * 为什么是 schema 而不是 database(2026-09-24 从 CREATE DATABASE ... TEMPLATE 改过来):
 *   沙箱里所有项目共用一个 PG 实例,每个项目只拿到自己的 schema,**没有 CREATEDB 权限**。
 *   测试隔离必须在这个权限下成立,否则"本机测试全绿、沙箱里一跑就挂"。
 *   代价是没有库级克隆可用,每个测试文件要重放一遍迁移 SQL(见 test-db.ts),几十毫秒级。
 *
 * 两个刻意的设计:
 * 1. 探针 schema 用 `migrate deploy` 而不是 `db push`。
 *    db push 是拿 schema.prisma 直接推,**根本不碰 migrations 目录** ——
 *    那样迁移文件本身永远不会被执行到,schema 与 migration 的漂移对测试完全不可见。
 * 2. 前缀带 pid,并且不改全局 process.env.DATABASE_URL。
 *    靠改全局环境变量给 PrismaClient 传参会逼得 vitest 必须串行跑;
 *    前缀写死则两个并发 vitest 进程会互删对方的 schema。
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

/*
 * 显式加载 .env。
 *
 * vitest 的 globalSetup 跑在一个干净的进程里,不会经过 src/platform/config/index.ts,
 * 所以拿不到 .env 里的 DATABASE_URL。
 *
 * 真实环境变量优先于 .env(loadEnvFile 不覆盖已存在的键)—— CI / 沙箱注入的
 * DATABASE_URL 不会被仓库里的 .env 盖掉。
 */
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // .env 不存在是正常情况(CI 用真实环境变量)
}

/** 本次运行的 schema 前缀,通过环境变量传给各测试文件 —— 这是唯一需要跨进程共享的值。 */
export const SCHEMA_PREFIX_ENV = 'TEST_SCHEMA_PREFIX';
/** 测试连的数据库(开发库),测试文件靠它建 schema。 */
export const TEST_DATABASE_URL_ENV = 'TEST_DATABASE_URL';

const schemaPrefix = `tmp_test_${process.pid}`;

/**
 * 测试连哪个数据库 —— 就是开发库(`DATABASE_URL`)。
 *
 * [不要为测试单独起一个实例] 隔离性已经由"每个测试文件一个独立 schema"
 * 完整解决了,测试之间连看见对方的表都做不到。
 *
 * (`docker-compose.test.yml` 是**测试环境**,也就是生产的预演 —— 完整四服务,
 *  给部署验证和 QA 用,与这里的单元测试无关。)
 */
const requireDatabaseUrl = (): string => {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL 未设置。跑测试前先起开发数据库:\n' +
        '  docker compose -f deploy/docker-compose.dev.yml up -d --wait',
    );
  }
  return url;
};

/** 删掉名字以 prefix 开头的全部 schema。上次被 Ctrl+C 掐断的残留也靠它清。 */
export const dropSchemasByPrefix = async (databaseUrl: string, prefix: string): Promise<void> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`,
      [`${prefix}\\_%`],
    );
    for (const { nspname } of rows) {
      await client.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
    }
  } finally {
    await client.end();
  }
};

export const setup = async (): Promise<void> => {
  const databaseUrl = requireDatabaseUrl();
  await dropSchemasByPrefix(databaseUrl, schemaPrefix);

  // 用 prisma CLI 把迁移跑进探针 schema。走环境变量传参给子进程,不污染当前进程。
  // stdio: 'inherit' —— 迁移失败时必须让人看见 prisma 的报错;
  // 用 'pipe' 把错误吞掉的话,建库失败只会表现为后续测试莫名其妙全红。
  execFileSync('pnpm', ['db', 'deploy'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_SCHEMA: `${schemaPrefix}_deploy` },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  process.env[SCHEMA_PREFIX_ENV] = schemaPrefix;
  process.env[TEST_DATABASE_URL_ENV] = databaseUrl;
};

export const teardown = async (): Promise<void> => {
  const databaseUrl = process.env[TEST_DATABASE_URL_ENV];
  if (databaseUrl === undefined) return;
  await dropSchemasByPrefix(databaseUrl, schemaPrefix);
};
