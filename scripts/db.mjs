/**
 * 数据库操作的唯一入口: pnpm db <子命令> [参数]
 *
 * 日常只需要三条:
 *   pnpm db migrate --name add_order   改完 schema.prisma 后: 生成迁移并应用到当前库
 *   pnpm db deploy                     拿到别人的代码后: 应用还没跑过的迁移
 *   pnpm db seed                       灌初始数据(幂等)
 *
 * 其余子命令:
 *   reset                [仅 _dev schema] 清空当前 schema、重跑全部迁移并灌种子
 *   status               查看迁移应用情况
 *   generate / studio    透传给 prisma
 *   up / down            [可选] 用 docker 起停本机开发库。沙箱(容器)里不可用
 *
 * 这个文件把 Prisma 的细节都收在这里,使用者不用关心:
 *   - prisma.config.ts 在 server/ 下,每条命令自动带 --config;
 *   - migrate 不用 `prisma migrate dev`: 它要临时建"影子库",沙箱的共享 PG 没有建库权限(P3014)。
 *     改用 `prisma migrate diff` 对比当前库与 schema.prisma 生成 SQL,本机与沙箱同一种做法;
 *   - 会改写库结构的 migrate / reset 只许在 _dev 结尾的 schema 上执行,_test / _prod 只能 deploy。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMENTS_QUERY, commentStatements, missingComments, parseSchemaComments, toCommentMap } from './db-comments.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRISMA_CONFIG = 'server/prisma.config.ts';
const SCHEMA_FILE = 'server/prisma/schema.prisma';
const MIGRATIONS_DIR = resolve(ROOT, 'server/prisma/migrations');
const DEV_COMPOSE = 'deploy/docker-compose.dev.yml';
const isWindows = process.platform === 'win32';

/**
 * 能否在这个 schema 上改写结构(migrate / reset)。
 *
 * 命名约定 <项目>_dev / <项目>_test / <项目>_prod(后缀),同一项目的几套环境在库里排在一起。
 * 判断看 schema 后缀而不是数据库主机: 团队共用一台开发库、各自用 _dev schema 是正常用法;
 * 而 _test / _prod 很可能和开发 schema 在同一个 PG 实例上,按主机判断反而拦错对象。
 */
export const isDisposableSchema = (schema) =>
  typeof schema === 'string' && schema.length > '_dev'.length && schema.endsWith('_dev');

/** 迁移名归一成小写下划线,如 "Add Order" -> "add_order"。归一后为空返回 null。 */
export const toMigrationName = (raw) => {
  if (typeof raw !== 'string') return null;
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return name === '' ? null : name;
};

/** 迁移目录名: <UTC 时间戳 YYYYMMDDHHMMSS>_<名字>,与 prisma 自己生成的格式一致。 */
export const migrationDirName = (name, now = new Date()) =>
  `${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${name}`;

const fail = (message) => {
  process.stderr.write(`[FAIL] ${message}\n`);
  process.exit(1);
};

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: isWindows });
  if (result.error !== undefined) fail(`无法执行 ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const prisma = (...args) => run('pnpm', ['exec', 'prisma', ...args, '--config', PRISMA_CONFIG]);

/** 动库的子命令必须明确 schema —— 不设就会静默落到 public。 */
const requireSchema = (sub) => {
  if (process.env.DATABASE_SCHEMA) return;
  fail(`pnpm db ${sub} 需要 DATABASE_SCHEMA(如 <项目名>_dev),在 .env 里配置。`);
};

const requireDevSchema = (sub) => {
  requireSchema(sub);
  const schema = process.env.DATABASE_SCHEMA;
  if (isDisposableSchema(schema)) return;
  fail(
    `pnpm db ${sub} 只允许在 _dev 结尾的开发 schema 上执行,当前是 ${schema}。\n` +
      '       测试 / 生产环境只用 pnpm db deploy(只执行还没跑过的迁移,不会改写已有结构)。',
  );
};

const requireDocker = () => {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    stdio: 'ignore',
    shell: isWindows,
  });
  if (probe.error === undefined && probe.status === 0) return;
  fail(
    '当前环境不能启动容器(没有 docker,或身处沙箱 / 容器内)。\n' +
      '       请在 .env 里把 DATABASE_URL 配成可用的 PG(沙箱里由平台提供)。',
  );
};

/**
 * 读当前库(DATABASE_SCHEMA)里的表与列注释。
 * pg 借用 server 包的依赖(Prisma 的 adapter-pg 本来就要它),根目录不为此新增依赖。
 */
const readDbComments = async () => {
  const { Client } = createRequire(resolve(ROOT, 'server/package.json'))('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return toCommentMap((await client.query(COMMENTS_QUERY, [process.env.DATABASE_SCHEMA])).rows);
  } finally {
    await client.end();
  }
};

/**
 * 生成迁移并应用。
 *
 * diff 的对比基准是"当前库的实际结构"。有人绕过迁移手工改过库的话,
 * 这些改动也会被算进新迁移 —— 在 _dev schema 上遇到这种情况,pnpm db reset 重建即可。
 *
 * 表 / 字段注释: Prisma 不会把 /// 写进库,这里补上。/// 必须齐全(否则拒绝生成);
 * 与当前库不一致的注释生成 COMMENT ON 追加进同一个迁移 —— 只改了注释也会生成迁移。
 * 规则与理由见 scripts/db-comments.mjs,一致性由 server/tests/db-comments.test.ts 守着。
 */
const migrate = async (rest) => {
  requireDevSchema('migrate');
  const flag = rest.indexOf('--name');
  const name = toMigrationName(flag >= 0 ? rest[flag + 1] : undefined);
  if (name === null) fail('pnpm db migrate 需要 --name <这次改了什么>,如 pnpm db migrate --name add_order');

  const models = parseSchemaComments(readFileSync(resolve(ROOT, SCHEMA_FILE), 'utf8'));
  const missing = missingComments(models);
  if (missing.length > 0) {
    fail(
      `${missing.length} 处缺注释,每张表、每个字段都必须有 /// 注释(写业务口径与 Why,不复述字段名):\n` +
        missing.map((m) => `         - ${m}`).join('\n'),
    );
  }

  const diff = spawnSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', SCHEMA_FILE, '--script', '--exit-code', '--config', PRISMA_CONFIG],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: isWindows },
  );
  if (diff.error !== undefined) fail(`无法执行 prisma migrate diff: ${diff.error.message}`);
  // --exit-code: 0 = 无差异,2 = 有差异,其他 = 出错
  if (diff.status !== 0 && diff.status !== 2) process.exit(diff.status ?? 1);
  const structural = diff.status === 2 ? diff.stdout : '';
  const comments = commentStatements(models, await readDbComments());
  if (structural === '' && comments.length === 0) {
    process.stdout.write('[INFO] schema.prisma 与当前库一致(结构与注释),没有需要生成的迁移。\n');
    return;
  }

  const dir = resolve(MIGRATIONS_DIR, migrationDirName(name));
  mkdirSync(dir, { recursive: true });
  const commentBlock =
    comments.length > 0 ? `\n-- 表与字段注释: 依 schema.prisma 的 /// 生成,勿手改\n${comments.join('\n')}\n` : '';
  writeFileSync(resolve(dir, 'migration.sql'), `-- ${name}\n-- 由 pnpm db migrate 生成。提交前通读一遍。\n\n${structural}${commentBlock}`);
  process.stdout.write(
    `[PASS] 已生成迁移 ${relative(ROOT, dir).replace(/\\/g, '/')}/migration.sql` +
      `(结构变更${structural === '' ? '无' : '有'},注释 ${comments.length} 条)\n`,
  );
  prisma('migrate', 'deploy');
  // prisma migrate dev 会顺带重新生成 Client,diff 流程要自己补上 —— 否则新表在代码里没有类型
  prisma('generate');
};

const COMMANDS = {
  migrate,
  deploy: (rest) => {
    requireSchema('deploy');
    prisma('migrate', 'deploy', ...rest);
  },
  seed: () => {
    requireSchema('seed');
    run('pnpm', ['exec', 'tsx', 'server/prisma/seed.ts']);
  },
  reset: (rest) => {
    requireDevSchema('reset');
    prisma('migrate', 'reset', '--force', ...rest);
    COMMANDS.seed([]);
  },
  status: (rest) => {
    requireSchema('status');
    prisma('migrate', 'status', ...rest);
  },
  generate: (rest) => prisma('generate', ...rest),
  studio: (rest) => prisma('studio', ...rest),
  up: () => {
    requireDocker();
    run('docker', ['compose', '-f', DEV_COMPOSE, 'up', '-d', '--wait']);
  },
  down: () => run('docker', ['compose', '-f', DEV_COMPOSE, 'down']),
};

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  // 与 prisma.config.ts 同一个来源: 环境变量优先,.env 兜底(loadEnvFile 不覆盖已有键)
  const envFile = resolve(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const [sub, ...rest] = process.argv.slice(2);
  const handler = sub === undefined ? undefined : COMMANDS[sub];
  if (handler === undefined) {
    fail(`未知子命令: ${sub ?? '(空)'}\n       用法: pnpm db <${Object.keys(COMMANDS).join(' | ')}> [参数]`);
  }
  await handler(rest);
}
