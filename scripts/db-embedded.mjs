/**
 * 嵌入式开发库: 用 npm 包 embedded-postgres 带的 PG 二进制,在项目的 .devdb/ 里起一个只给本项目用的开发库。
 * 由 scripts/db.mjs 的 up / down 调用(项目里有 .devdb/ 就走这里,否则走 docker)。
 *
 * 定位是兜底: 开发库优先用容器外现成的 PG;没有、又不能跑 docker(如沙箱)时才用它。
 *
 * 为什么这样做:
 *   - 不进项目依赖与 lockfile: 二进制约 60MB(Linux,Windows 约 100MB)且分平台,只有选了这种方式的项目才在 .devdb/ 里单独 npm 安装;
 *   - 版本跟 17.x 走(与生产 PG 17 同大版本),不钉死小版本: 安装时取 npm 上 17.x 的最新一版;
 *   - 不用包自带的 start(): 它在 Node 进程退出时会把库一起关掉。直接用包里的 pg_ctl 后台启动;
 *   - 数据在 .devdb/data: 沙箱里项目目录在持久卷上,沙箱重建后数据还在;进程不在,重启后 pnpm db up 拉起;
 *   - 账号、密码、端口、库名全部取自 .env 的 DATABASE_URL(唯一真源),只监听 127.0.0.1。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const PG_MAJOR = '17';
const isWindows = process.platform === 'win32';

const fail = (message) => {
  process.stderr.write(`[FAIL] ${message}\n`);
  process.exit(1);
};

const paths = (root) => {
  const dir = resolve(root, '.devdb');
  return {
    dir,
    data: join(dir, 'data'),
    log: join(dir, 'postgres.log'),
    // 平台包名: linux-x64 / darwin-arm64 / windows-x64(Windows 叫 windows,不是 Node 的 win32)
    bin: join(dir, 'node_modules', '@embedded-postgres', `${isWindows ? 'windows' : process.platform}-${process.arch}`, 'native', 'bin'),
  };
};

/** 项目是否用嵌入式开发库: 由 pnpm db up --embedded 初始化过。 */
export const usesEmbedded = (root) => existsSync(join(paths(root).dir, 'package.json'));

const tool = (p, name) => join(p.bin, isWindows ? `${name}.exe` : name);

const exec = (cmd, args, what) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: isWindows && cmd === 'npm' });
  if (r.error !== undefined) fail(`${what}: 无法执行 ${cmd}: ${r.error.message}`);
  if (r.status !== 0) fail(`${what}失败(exit=${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n       ')}`);
  return r.stdout;
};

/** 连接参数取自 DATABASE_URL;嵌入式库只允许本机地址。 */
const target = () => {
  const raw = process.env.DATABASE_URL;
  if (!raw) fail('嵌入式开发库需要 .env 里的 DATABASE_URL(账号、密码、端口、库名都从它取)');
  const u = new URL(raw);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) fail(`嵌入式开发库只能是本机地址,DATABASE_URL 指向 ${u.hostname}`);
  if (!u.username || !u.password || !u.port) fail('DATABASE_URL 要写全账号、密码与端口,如 postgresql://app:密码@127.0.0.1:7103/app_dev');
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    port: u.port,
    database: u.pathname.slice(1),
  };
};

/** 取 npm 上 17.x 的最新一版(embedded-postgres 的版本都是 17.x.0-beta.N 这种预发布号,不能用 @17 范围)。 */
const latestMajor = () => {
  const versions = JSON.parse(exec('npm', ['view', 'embedded-postgres', 'versions', '--json'], '查询 embedded-postgres 版本'));
  const matched = versions.filter((v) => v.startsWith(`${PG_MAJOR}.`));
  if (matched.length === 0) fail(`npm 上没有 embedded-postgres ${PG_MAJOR}.x`);
  return matched.at(-1);
};

const install = (p) => {
  const version = latestMajor();
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(join(p.dir, 'package.json'), `${JSON.stringify({ name: 'devdb', private: true }, null, 2)}\n`);
  process.stdout.write(`[INFO] 安装 embedded-postgres@${version} 到 .devdb/(只装本平台的二进制)\n`);
  exec('npm', ['install', '--prefix', p.dir, '--no-audit', '--no-fund', `embedded-postgres@${version}`], '安装 embedded-postgres');
  if (!existsSync(tool(p, 'pg_ctl'))) fail(`安装后找不到 ${tool(p, 'pg_ctl')}(平台 ${process.platform}-${process.arch} 可能不受支持)`);
};

const initData = (p, t) => {
  const pwfile = join(p.dir, '.pwfile');
  writeFileSync(pwfile, t.password, { mode: 0o600 });
  try {
    exec(tool(p, 'initdb'), ['-D', p.data, '-U', t.user, `--pwfile=${pwfile}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--no-locale'], '初始化数据目录');
  } finally {
    rmSync(pwfile, { force: true });
  }
};

const isRunning = (p) => spawnSync(tool(p, 'pg_ctl'), ['status', '-D', p.data], { stdio: 'ignore' }).status === 0;

const ensureDatabase = async (root, t) => {
  if (!t.database || t.database === 'postgres') return;
  const { Client } = createRequire(resolve(root, 'server/package.json'))('pg');
  const client = new Client({ host: '127.0.0.1', port: Number(t.port), user: t.user, password: t.password, database: 'postgres' });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [t.database]);
    if (rowCount === 0) await client.query(`CREATE DATABASE "${t.database.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }
};

/** 起库: 首次(--embedded)安装并初始化;之后每次只是启动。已在运行则跳过。 */
export const upEmbedded = async (root, { init = false } = {}) => {
  const p = paths(root);
  const t = target();
  if (!usesEmbedded(root)) {
    if (!init) fail('项目没有初始化嵌入式开发库');
    install(p);
  }
  if (!existsSync(join(p.data, 'PG_VERSION'))) initData(p, t);
  if (isRunning(p)) {
    process.stdout.write(`[PASS] 嵌入式开发库已在运行(127.0.0.1:${t.port})\n`);
  } else {
    // [坑] 不接管输出: 后台的 postgres 会继承输出管道,管道不关 spawnSync 就一直不返回(Windows 实测);输出本来就写在 -l 日志里
    const started = spawnSync(tool(p, 'pg_ctl'), ['start', '-D', p.data, '-l', p.log, '-w', '-o', `-p ${t.port} -h 127.0.0.1`], {
      stdio: 'ignore',
    });
    if (started.status !== 0) fail(`启动嵌入式开发库失败(exit=${started.status}),看日志 ${p.log}`);
    process.stdout.write(`[PASS] 嵌入式开发库已启动(127.0.0.1:${t.port},数据 .devdb/data)\n`);
  }
  await ensureDatabase(root, t);
};

export const downEmbedded = (root) => {
  const p = paths(root);
  if (!isRunning(p)) {
    process.stdout.write('[INFO] 嵌入式开发库没有在运行\n');
    return;
  }
  exec(tool(p, 'pg_ctl'), ['stop', '-D', p.data, '-m', 'fast', '-w'], '停止嵌入式开发库');
  process.stdout.write('[PASS] 嵌入式开发库已停止\n');
};
