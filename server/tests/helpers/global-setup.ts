/**
 * vitest 全局前置 —— 建一次「模板数据库」,供所有测试文件复制。
 *
 * 干什么: 在跑任何测试之前,用真实的 prisma migrate deploy 建一个空库,
 *         之后每个需要数据库的测试用 `CREATE DATABASE ... TEMPLATE` 复制一份。
 *
 * 解决什么问题:
 *   直接让每个测试自己跑一次 prisma CLI 建库要好几秒,几百个用例就是十几分钟,
 *   TDD 的反馈循环直接废掉。而 mock 掉仓储又拿不到"SQL 到底对不对"的置信度。
 *   模板库 + 复制把成本压到几十毫秒 —— 既连真库又够快。
 *
 * ── PG 的 TEMPLATE 就是原来的"复制文件" ────────────────────────
 *
 *   SQLite 时代这里是 copyFileSync 复制一个 .db 文件。换成 PG 之后,
 *   等价物是 `CREATE DATABASE x TEMPLATE y` —— PG 原生的库级克隆,
 *   直接在数据目录里复制文件,不重放 DDL,所以同样快。
 *
 *   [约束] TEMPLATE 源库**不能有活动连接**。所以本文件建完模板库之后
 *   必须彻底断开(下面显式 end 了连接池),否则所有测试文件会在
 *   "source database is being accessed by other users" 上一起失败。
 *
 * 两个刻意的设计:
 * 1. 用 `migrate deploy` 而不是 `db push` 建模板库。
 *    db push 是拿 schema.prisma 直接推,**根本不碰 migrations 目录** ——
 *    那样迁移文件本身永远不会被执行到,schema 与 migration 的漂移对测试完全不可见。
 *    用 deploy 意味着"迁移文件本身"也在测试覆盖之下。
 * 2. 模板库名带 pid,并且不改全局 process.env.DATABASE_URL。
 *    靠改全局环境变量给 PrismaClient 传参会逼得 vitest 必须串行跑;
 *    库名写死则两个并发 vitest 进程会互删互建。这里两个问题一起规避,测试可以并行。
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
 * vitest 的 globalSetup 跑在一个干净的进程里,不会经过 src/config/index.ts,
 * 所以拿不到 .env 里的 DATABASE_URL。SQLite 时代不需要这一步(测试自己建临时文件),
 * 换成 PG 之后必须先知道连哪个实例。
 *
 * 真实环境变量优先于 .env(loadEnvFile 不覆盖已存在的键)—— CI 里注入
 * DATABASE_URL 指向 service container,不会被仓库里的 .env 盖掉。
 */
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // .env 不存在是正常情况(CI 用真实环境变量)
}

/** 模板库名通过环境变量传给各测试文件 —— 这是唯一需要跨进程共享的值。 */
export const TEMPLATE_DB_ENV = 'TEST_TEMPLATE_DB';
/** 基础连接串(指向维护库)也要传,测试文件靠它连上去执行 CREATE DATABASE。 */
export const ADMIN_URL_ENV = 'TEST_ADMIN_DATABASE_URL';

/**
 * 把连接串里的库名换掉,其余部分(用户、密码、主机、端口、参数)原样保留。
 *
 * 为什么要有这个: 建库、删库这类操作不能在目标库自己身上执行,必须连到另一个库
 * (习惯上是 `postgres` 维护库)。而连接信息只有 DATABASE_URL 一个来源,
 * 手工拼字符串迟早会漏掉密码里的特殊字符或某个查询参数。
 */
export const withDatabase = (connectionString: string, database: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
};

const templateName = `keel_test_template_${process.pid}`;

/**
 * 测试连哪个数据库 —— 就是开发库(`DATABASE_URL`)。
 *
 * [不要为测试单独起一个实例] 隔离性已经由"每个测试文件一个独立 database"
 * 完整解决了,测试之间连看见对方的表都做不到。再起一个 PG 实例只会多占端口、
 * 多一份要跟着升级的配置,换不来任何隔离性。
 *
 * (`docker-compose.test.yml` 是**测试环境**,也就是生产的预演 —— 完整四服务,
 *  给部署验证和 QA 用,与这里的单元测试无关。)
 *
 * CI 里则注入指向 service container 的 DATABASE_URL,同样走这一条。
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

/** 连到维护库执行一条语句。建库/删库都走这里。 */
const runOnMaintenanceDb = async (baseUrl: string, sql: string): Promise<void> => {
  const client = new Client({ connectionString: withDatabase(baseUrl, 'postgres') });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    // 必须断开: 留着连接会让后续的 CREATE DATABASE ... TEMPLATE 失败
    await client.end();
  }
};

export const setup = async (): Promise<void> => {
  const baseUrl = requireDatabaseUrl();
  const templateUrl = withDatabase(baseUrl, templateName);

  // 上一次跑测试如果被 Ctrl+C 掐断,模板库会残留下来 —— 先删再建,保证干净。
  await runOnMaintenanceDb(baseUrl, `DROP DATABASE IF EXISTS "${templateName}"`);
  await runOnMaintenanceDb(baseUrl, `CREATE DATABASE "${templateName}"`);

  // 用 prisma CLI 把迁移跑进模板库。走环境变量传参给子进程,不污染当前进程。
  // stdio: 'inherit' —— 迁移失败时必须让人看见 prisma 的报错;
  // 用 'pipe' 把错误吞掉的话,建库失败只会表现为后续测试莫名其妙全红。
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: templateUrl },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  process.env[TEMPLATE_DB_ENV] = templateName;
  process.env[ADMIN_URL_ENV] = baseUrl;
};

export const teardown = async (): Promise<void> => {
  const baseUrl = process.env[ADMIN_URL_ENV];
  if (baseUrl === undefined) return;

  // 先踢掉可能残留的连接再删库 —— 某个测试没 cleanup 干净的话,
  // DROP DATABASE 会卡在"正在被访问"上,teardown 挂住比测试失败更难查。
  await runOnMaintenanceDb(
    baseUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname LIKE 'keel_test_%' AND pid <> pg_backend_pid()`,
  );
  await runOnMaintenanceDb(baseUrl, `DROP DATABASE IF EXISTS "${templateName}"`);
};
