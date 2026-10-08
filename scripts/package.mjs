/**
 * 打发布包: pnpm package --mode <pm2|docker> [--with-deps]
 *
 * 干什么: 把当前提交打成一个可部署的 tar.gz,放在 release/ 下(已被 git 忽略)。
 *   发布包里带 release.json: 项目名、版本、提交号、分支、提交说明、构建时间、构建人、构建平台、迁移清单。
 *
 * 两种形态:
 *   pm2     构建好的产物: 后端单文件 bundle + Prisma 生成物与迁移 + 前端静态文件。
 *           第三方依赖不在 bundle 里(见 server/scripts/build.mjs),所以:
 *             --with-deps   用 pnpm deploy 按 lockfile 导出 node_modules 一起打包。
 *                           只在构建机与目标机系统、架构一致时可用(Prisma 引擎按平台区分)。
 *             不带          只带依赖清单,到目标机上 npm install --omit=dev。
 *   docker  当前提交的源码(git archive),在目标机上 docker compose build。
 *
 * 为什么拒绝脏工作区: 部署出去的东西必须能对应到一个确定的提交,否则出了问题没法复现。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const isWindows = process.platform === 'win32';

/**
 * Windows 上用系统自带的 bsdtar。Git Bash 自带的 GNU tar 会把 C:\... 里的冒号当成「远程主机:路径」,
 * 报 Cannot connect to C: resolve failed。Linux 上照常用 tar。
 */
const TAR = isWindows && fs.existsSync('C:/Windows/System32/tar.exe') ? 'C:/Windows/System32/tar.exe' : 'tar';

const fail = (message) => {
  process.stderr.write(`[FAIL] ${message}\n`);
  process.exit(1);
};
const pass = (message) => process.stdout.write(`[PASS] ${message}\n`);

const capture = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: isWindows && cmd === 'pnpm' });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} 失败: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
};

const runVisible = (cmd, args, cwd = ROOT) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: isWindows && cmd === 'pnpm', env: { ...process.env, CI: 'true' } });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} 失败(exit=${r.status})`);
};

// ============================================================ 参数
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const mode = option('mode');
if (mode !== 'pm2' && mode !== 'docker') fail('用法: pnpm package --mode <pm2|docker> [--with-deps]');
const withDeps = flag('with-deps');
if (withDeps && mode !== 'pm2') fail('--with-deps 只用于 pm2 形态(docker 形态在目标机上构建镜像)');

// ============================================================ git 信息
if (capture('git', ['status', '--porcelain']) !== '') {
  fail('工作区有未提交的改动。先提交,发布包必须对应一个确定的提交');
}
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const commit = capture('git', ['rev-parse', 'HEAD']);
const shortCommit = commit.slice(0, 7);
const info = {
  name: rootPkg.name,
  version: rootPkg.version,
  mode,
  deps: mode === 'docker' ? 'build-on-target' : withDeps ? 'bundled' : 'install-on-target',
  git: {
    commit,
    shortCommit,
    branch: capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    commitTime: capture('git', ['log', '-1', '--format=%cI']),
    subject: capture('git', ['log', '-1', '--format=%s']),
  },
  builtAt: new Date().toISOString(),
  builtBy: capture('git', ['config', 'user.name']),
  buildPlatform: `${process.platform}-${process.arch}`,
  nodeRequired: rootPkg.engines?.node ?? '>=22.12',
  migrations: fs
    .readdirSync(path.join(ROOT, 'server/prisma/migrations'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(),
};
pass(`提交 ${shortCommit}(${info.git.branch})${info.git.subject}`);

// ============================================================ 组装
const stamp = info.builtAt.replace(/[-:T]/g, '').slice(0, 14);
const baseName = `${info.name}-${stamp}-${shortCommit}-${mode}${withDeps ? '-deps' : ''}`;
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'package-'));
const copy = (from, to = from) => fs.cpSync(path.join(ROOT, from), path.join(staging, to), { recursive: true });

if (mode === 'docker') {
  // 当前提交的源码。不含工作区里被忽略的东西(.env、node_modules、dist)
  const tarPath = path.join(staging, '..', `${path.basename(staging)}-src.tar`);
  capture('git', ['archive', '--format=tar', '-o', tarPath, 'HEAD']);
  const x = spawnSync(TAR, ['-xf', tarPath, '-C', staging], { encoding: 'utf8' });
  if (x.status !== 0) fail(`解包源码失败: ${x.stderr}`);
  fs.rmSync(tarPath);
  pass('源码已导出(git archive HEAD)');
} else {
  runVisible('pnpm', ['build']);
  pass('前后端构建完成');
  copy('server/dist');
  copy('server/src/generated');
  copy('server/prisma');
  copy('server/prisma.config.ts');
  copy('server/package.json');
  copy('web/dist');
  copy('deploy/start-migrate.sh', 'start-migrate.sh');
  // config 靠"向上找第一个含 pnpm-workspace.yaml 的目录"定位仓库根,发布包里必须有它
  copy('pnpm-workspace.yaml');

  // 运行时依赖清单: 后端的依赖去掉 workspace 包(已被打进 bundle)
  const serverPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/package.json'), 'utf8'));
  const dependencies = Object.fromEntries(
    Object.entries(serverPkg.dependencies).filter(([, v]) => !String(v).startsWith('workspace:')),
  );
  fs.writeFileSync(
    path.join(staging, 'package.json'),
    `${JSON.stringify({ name: info.name, version: info.version, private: true, type: 'module', engines: rootPkg.engines, dependencies }, null, 2)}\n`,
  );

  if (withDeps) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'package-deps-'));
    process.stdout.write('[INFO] 导出生产依赖(pnpm deploy),体积较大,需要几分钟...\n');
    runVisible('pnpm', ['deploy', '--filter=@app/server', '--prod', '--legacy', path.join(out, 'server')]);
    fs.renameSync(path.join(out, 'server', 'node_modules'), path.join(staging, 'node_modules'));
    fs.rmSync(out, { recursive: true, force: true });
    pass(`生产依赖已打包(构建平台 ${info.buildPlatform},目标机必须一致)`);
  }
}

fs.writeFileSync(path.join(staging, 'release.json'), `${JSON.stringify(info, null, 2)}\n`);

// ============================================================ 压缩
fs.mkdirSync(RELEASE_DIR, { recursive: true });
const file = path.join(RELEASE_DIR, `${baseName}.tar.gz`);
const t = spawnSync(TAR, ['-czf', file, '-C', staging, '.'], { encoding: 'utf8' });
if (t.status !== 0) fail(`压缩失败: ${t.stderr}`);
fs.rmSync(staging, { recursive: true, force: true });

const sizeMb = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
pass(`发布包 ${path.relative(ROOT, file).replace(/\\/g, '/')}(${sizeMb} MB,迁移 ${info.migrations.length} 个)`);
// 最后一行给调用方(deploy-project skill)解析
process.stdout.write(`RELEASE_FILE=${file}\n`);
