#!/usr/bin/env node
/**
 * deploy-project:把项目部署到目标机。密码只从环境变量 DEPLOY_PASSWORD 读。
 *
 *   node deploy.mjs probe  --host H --user U [--port 22] [--accept-host-key FP]
 *   node deploy.mjs deploy --project-dir D --env test|prod --mode pm2|docker --host H --user U
 *                          [--port 22] [--app-port N] [--backend-port N] [--accept-host-key FP]
 *                          [--install] [--mirror aliyun|tuna|ustc | --keep-mirror]
 *                          [--confirm-migrations] [--deps bundled|target] [--skip-nginx]
 *   node deploy.mjs status
 *
 * 退出码: 0 成功 / 1 失败 / 3 需要用户确认(输出 NEED_CONFIRM <类型> 与说明,AI 问过用户后带对应参数重跑)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { canSudo, describe, probe } from './lib/probe.mjs';
import { MIRRORS, install, switchMirror, usesOfficialApt } from './lib/install.mjs';
import { findDeployment, knownFingerprint, listDeployments, recordDeployment } from './lib/registry.mjs';
import { HostKeyUnconfirmed, connect, exec, shq, upload } from './lib/ssh.mjs';

const isWindows = process.platform === 'win32';
const TAR = isWindows && fs.existsSync('C:/Windows/System32/tar.exe') ? 'C:/Windows/System32/tar.exe' : 'tar';
const NPM_REGISTRY = process.env.DEPLOY_NPM_REGISTRY ?? 'https://registry.npmmirror.com';
const KEEP_RELEASES = 5;
const DESTRUCTIVE = /\b(DROP\s+(TABLE|SCHEMA|COLUMN|INDEX|TYPE|VIEW)|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+\S+\s+DROP)\b/i;

// ============================================================ 输出
let stepNo = 0;
const step = (t) => process.stdout.write(`\n[${++stepNo}] ${t}\n`);
const pass = (m) => process.stdout.write(`  [PASS] ${m}\n`);
const info = (m) => process.stdout.write(`  [INFO] ${m}\n`);
const warn = (m) => process.stdout.write(`  [WARN] ${m}\n`);
const fail = (m) => {
  process.stderr.write(`  [FAIL] ${m}\n`);
  process.exit(1);
};
const needConfirm = (kind, message) => {
  process.stdout.write(`\nNEED_CONFIRM ${kind}\n${message}\n`);
  process.exit(3);
};

// ============================================================ 参数
const [command, ...rest] = process.argv.slice(2);
const FLAGS = new Set(['install', 'confirm-migrations', 'skip-nginx', 'keep-mirror']);
const args = {};
for (let i = 0; i < rest.length; i += 1) {
  const key = rest[i].replace(/^--/, '');
  if (FLAGS.has(key)) args[key] = true;
  else {
    args[key] = rest[i + 1];
    i += 1;
  }
}

const target = () => {
  if (!args.host || !args.user) fail('需要 --host 与 --user');
  const port = Number(args.port ?? 22);
  return {
    host: args.host,
    port,
    user: args.user,
    password: process.env.DEPLOY_PASSWORD,
    expectedFingerprint: args['accept-host-key'] ?? knownFingerprint(args.host, port),
  };
};

const open = async (t) => {
  try {
    return await connect(t);
  } catch (e) {
    if (e instanceof HostKeyUnconfirmed) {
      needConfirm('host-key', `首次连接 ${t.host}:${t.port},主机指纹 ${e.fingerprint}\n请用户核对后,带 --accept-host-key ${e.fingerprint} 重跑`);
    }
    fail(`连接 ${t.host}:${t.port} 失败: ${e.message}`);
  }
};

// ============================================================ probe
const cmdProbe = async () => {
  const t = target();
  const { conn, fingerprint } = await open(t);
  const facts = await probe(conn, t.password);
  conn.end();
  process.stdout.write(`主机指纹  ${fingerprint}\n${describe(facts)}\n`);
};

// ============================================================ status
const cmdStatus = () => {
  const list = listDeployments();
  if (list.length === 0) return process.stdout.write('还没有部署记录\n');
  for (const d of list) {
    const last = d.releases.at(-1);
    process.stdout.write(
      `${d.project} [${d.env}] ${d.user}@${d.host}:${d.port}  ${d.mode}  访问 http://${d.host}:${d.appPort}/\n` +
        `  最近一次: ${last?.id ?? '-'}  ${last?.status ?? '-'}  分支 ${last?.branch ?? '-'}  ${last?.at ?? ''}\n`,
    );
  }
};

// ============================================================ deploy:本地检查
const git = (dir, a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' }).stdout.trim();

const localChecks = (dir, env) => {
  if (!fs.existsSync(path.join(dir, 'package.json'))) fail(`--project-dir 不是项目目录: ${dir}`);
  const name = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
  const envFile = path.join(dir, 'deploy', `.env.${env}`);
  if (!fs.existsSync(envFile)) {
    needConfirm('env-file', `缺少 deploy/.env.${env}。请向用户要 ${env} 环境的数据库连接串与管理员初始密码,写入:\n  DATABASE_URL="postgresql://..."\n  DATABASE_SCHEMA=${name.replace(/-/g, '_')}_${env}\n  SEED_ADMIN_PASSWORD=...`);
  }
  const vars = parseEnv(fs.readFileSync(envFile, 'utf8'));
  if (!vars.DATABASE_URL || !vars.DATABASE_SCHEMA) fail(`deploy/.env.${env} 必须有 DATABASE_URL 与 DATABASE_SCHEMA`);
  if (!vars.SEED_ADMIN_PASSWORD) {
    needConfirm('env-file', `deploy/.env.${env} 缺少 SEED_ADMIN_PASSWORD。请向用户要 ${env} 环境的管理员初始密码,写入:\n  SEED_ADMIN_PASSWORD=...`);
  }
  if (!vars.DATABASE_SCHEMA.endsWith(`_${env}`)) fail(`DATABASE_SCHEMA=${vars.DATABASE_SCHEMA} 与环境 ${env} 不匹配,应以 _${env} 结尾`);
  if (git(dir, ['status', '--porcelain']) !== '') fail('工作区有未提交的改动。先提交,部署必须对应一个确定的提交');
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (env === 'prod' && branch !== 'main') fail(`生产环境只能部署 main 分支,当前是 ${branch}`);
  if (env === 'prod' && git(dir, ['remote']) !== '') {
    spawnSync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: dir });
    if (git(dir, ['rev-parse', 'HEAD']) !== git(dir, ['rev-parse', 'origin/main'])) {
      warn('本地 main 与 origin/main 不一致(未推送或未拉取),部署的是本地这份');
    }
  }
  return { name, vars, branch };
};

// ============================================================ deploy:需求检查
const versionAtLeast = (v, major, minor) => {
  const [a, b] = (v ?? '').replace(/^v/, '').split('.').map(Number);
  return a > major || (a === major && b >= minor);
};

const missingFor = (mode, facts) => {
  const missing = [];
  if (mode === 'docker') {
    if (!facts.docker_cli) missing.push('docker');
    if (!facts.compose) missing.push('compose');
  } else {
    if (!versionAtLeast(facts.node, 22, 12)) missing.push('node');
    if (!facts.pm2) missing.push('pm2');
    if (!facts.nginx && !args['skip-nginx']) missing.push('nginx');
  }
  return missing;
};

// ============================================================ deploy:端口
const pickPorts = (facts, previous, segmentPort, mode) => {
  const appPort = Number(args['app-port'] ?? previous?.appPort ?? segmentPort);
  const backendPort = mode === 'pm2' ? Number(args['backend-port'] ?? previous?.backendPort ?? appPort + 10) : null;
  const ours = new Set([previous?.appPort, previous?.backendPort].filter(Boolean));
  const conflicts = [appPort, backendPort].filter((p) => p !== null && facts.ports.includes(p) && !ours.has(p));
  if (conflicts.length > 0) {
    const free = [];
    for (let p = appPort + 100; free.length < 3 && p < 65000; p += 100) if (!facts.ports.includes(p)) free.push(p);
    fail(`端口冲突: ${conflicts.join(', ')} 已被占用。换端口用 --app-port(可选: ${free.join(', ')})`);
  }
  return { appPort, backendPort };
};

// ============================================================ deploy:打包
const buildRelease = (dir, mode, withDeps) => {
  const a = ['package', '--mode', mode, ...(withDeps ? ['--with-deps'] : [])];
  const r = spawnSync('pnpm', a, { cwd: dir, encoding: 'utf8', shell: isWindows, env: { ...process.env, CI: 'true' } });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0) fail(`打包失败:\n${out.trim().split('\n').slice(-15).join('\n')}`);
  const file = out.match(/RELEASE_FILE=(.+)/)?.[1]?.trim();
  if (!file) fail('打包没有输出 RELEASE_FILE');
  const json = spawnSync(TAR, ['-xzOf', file, './release.json'], { encoding: 'utf8' }).stdout;
  return { file, release: JSON.parse(json) };
};

// ============================================================ deploy:主流程
const cmdDeploy = async () => {
  const dir = path.resolve(args['project-dir'] ?? '.');
  const env = args.env;
  const mode = args.mode;
  if (!['test', 'prod'].includes(env)) fail('--env 必须是 test 或 prod');
  if (!['pm2', 'docker'].includes(mode)) fail('--mode 必须是 pm2 或 docker');

  step('本地检查');
  const { name, vars, branch } = localChecks(dir, env);
  pass(`项目 ${name},环境 ${env},分支 ${branch},schema ${vars.DATABASE_SCHEMA}`);

  step('连接并探测目标机');
  const t = target();
  const { conn, fingerprint } = await open(t);
  let facts = await probe(conn, t.password);
  pass(`已连接 ${t.user}@${t.host}:${t.port}(${fingerprint})`);
  process.stdout.write(`${describe(facts).replace(/^/gm, '    ')}\n`);
  const sudoOpt = { sudo: facts.sudo !== 'root', sudoPassword: t.password };

  step('环境需求');
  let missing = missingFor(mode, facts);
  if (missing.length > 0) {
    if (!canSudo(facts)) {
      needConfirm('no-sudo', `目标机缺少: ${missing.join(', ')},而账号 ${facts.user} 没有可用的 sudo(${facts.sudo})。\n请问用户: 由管理员手工安装,还是提供有 sudo 权限的账号?`);
    }
    if (!args.install) {
      needConfirm('install', `目标机缺少: ${missing.join(', ')}。安装需要 sudo(包管理器 ${facts.pkg})。\n请问用户是否同意安装;同意后带 --install 重跑`);
    }
    if (usesOfficialApt(facts) && !args.mirror && !args['keep-mirror']) {
      needConfirm(
        'mirror',
        `目标机的 apt 源是国外官方源(${facts.aptHosts.join(', ')}),在国内装软件会很慢。\n` +
          `请问用户是否换成国内镜像(会先备份原文件): 同意带 --mirror ${Object.keys(MIRRORS).join('|')},不换带 --keep-mirror`,
      );
    }
    if (args.mirror) {
      const out = await switchMirror(conn, facts, args.mirror, t.password);
      pass(`已换成 ${args.mirror} 镜像\n${out.replace(/^/gm, '    ')}`);
    }
    const r = await install(conn, facts, missing, t.password, info, args.mirror);
    for (const f of r.failed) warn(`${f.item} 安装失败:\n${f.output.replace(/^/gm, '      ')}`);
    if (r.failed.length > 0) fail('安装未完成。可在 skill 的 tmp/ 下写临时脚本处理,处理后把经验记进 LESSONS.md');
    facts = await probe(conn, t.password);
    missing = missingFor(mode, facts);
    if (missing.length > 0) fail(`安装后仍缺少: ${missing.join(', ')}`);
    pass(`已安装: ${r.ok.join(', ')}`);
  } else pass(mode === 'docker' ? `docker ${facts.docker || '(需 sudo)'} / compose ${facts.compose}` : `node ${facts.node} / pm2 ${facts.pm2} / nginx ${facts.nginx || '跳过'}`);
  const dockerSudo = mode === 'docker' && !facts.docker && !facts.inDockerGroup;
  if (dockerSudo && !canSudo(facts)) needConfirm('no-sudo', `账号 ${facts.user} 不在 docker 组且没有 sudo,无法操作 docker。请问用户如何处理`);
  if (mode === 'pm2' && !args['skip-nginx'] && !canSudo(facts)) {
    needConfirm('no-sudo', `pm2 方式要写 nginx 站点配置,需要 sudo,而账号 ${facts.user} 没有。\n请问用户: 提供有 sudo 的账号,还是带 --skip-nginx 只部署后端(nginx 配置会打印出来由管理员放置)?`);
  }

  step('端口检查');
  const previous = findDeployment(name, env, t.host);
  const devPort = Number(parseEnv(fs.readFileSync(path.join(dir, '.env.example'), 'utf8')).PORT ?? 7101);
  const { appPort, backendPort } = pickPorts(facts, previous, env === 'prod' ? devPort : devPort + 3, mode);
  pass(`对外端口 ${appPort}${backendPort ? `,后端端口 ${backendPort}` : ''}`);

  step('打包');
  const buildPlatform = `${process.platform}-${process.arch}`;
  const withDeps = mode === 'pm2' && (args.deps ?? (buildPlatform === facts.platform ? 'bundled' : 'target')) === 'bundled';
  info(mode === 'pm2' ? `依赖: ${withDeps ? `随包上传(构建平台与目标一致 ${buildPlatform})` : `到目标机安装(构建 ${buildPlatform},目标 ${facts.platform})`}` : '目标机上构建镜像');
  const { file, release } = buildRelease(dir, mode, withDeps);
  if (env === 'prod' && release.git.branch !== 'main') fail(`发布包来自分支 ${release.git.branch},生产环境只能部署 main`);
  pass(`${path.basename(file)}(提交 ${release.git.shortCommit},分支 ${release.git.branch})`);

  // ---------------------------------------------------- 远端目录
  const base = previous?.baseDir ?? (canSudo(facts) ? '/opt/apps' : `${facts.home}/apps`);
  const envDir = `${base}/${name}/${env}`;
  const id = path.basename(file).replace(/\.tar\.gz$/, '');
  const rel = `${envDir}/releases/${id}`;
  const remote = async (cmd, opt = {}) => {
    const r = await exec(conn, cmd, opt);
    if (r.code !== 0 && !opt.allowFail) fail(`远端命令失败: ${cmd.split('\n')[0]}\n${`${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-20).join('\n')}`);
    return r;
  };
  const docker = (cmd, opt = {}) => remote(`cd ${shq(rel)} && ${cmd}`, { ...opt, ...(dockerSudo ? sudoOpt : {}) });

  step(`上传到 ${envDir}`);
  if (base.startsWith('/opt/')) await remote(`mkdir -p ${shq(base)} && chown ${facts.user} ${shq(base)}`, sudoOpt);
  await remote(`mkdir -p ${shq(`${envDir}/releases`)} ${shq(`${envDir}/shared/logs`)}`);
  await upload(conn, file, `${rel}.tar.gz`);
  await remote(`mkdir -p ${shq(rel)} && tar -xzf ${shq(`${rel}.tar.gz`)} -C ${shq(rel)} && rm -f ${shq(`${rel}.tar.gz`)}`);
  pass(`releases/${id}`);

  // ---------------------------------------------------- 共享配置(JWT 以目标机为准)
  step('环境配置 shared/.env');
  const sharedEnv = `${envDir}/shared/.env`;
  const current = parseEnv((await remote(`cat ${shq(sharedEnv)} 2>/dev/null || true`)).stdout);
  const merged = {
    ...current,
    NODE_ENV: 'production',
    DATABASE_URL: vars.DATABASE_URL,
    DATABASE_SCHEMA: vars.DATABASE_SCHEMA,
    SEED_ADMIN_PASSWORD: vars.SEED_ADMIN_PASSWORD,
    ...(mode === 'pm2' ? { PORT: String(backendPort), HOST: '127.0.0.1', LOG_FILE: `${envDir}/shared/logs/app.jsonl` } : { APP_PORT: String(appPort) }),
  };
  const firstJwt = !merged.JWT_SECRET;
  if (firstJwt) merged.JWT_SECRET = (await remote(`head -c 48 /dev/urandom | base64 | tr -d '\\n=+/'`)).stdout.trim();
  const envText = `${Object.entries(merged).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n')}\n`;
  await remote(`umask 077 && cat > ${shq(sharedEnv)} <<'__ENV__'\n${envText}__ENV__`);
  pass(`已写入(权限 600)${firstJwt ? ',首次部署已在目标机生成 JWT_SECRET' : ',沿用目标机已有的 JWT_SECRET'}`);

  // ---------------------------------------------------- 依赖 / 镜像
  let composeName;
  const composeFile = `deploy/docker-compose.${env}.yml`;
  const compose = `docker compose --env-file ${shq(sharedEnv)} -f ${composeFile}`;
  if (mode === 'pm2') {
    await remote(`ln -sfn ${shq(sharedEnv)} ${shq(`${rel}/.env`)}`);
    if (!withDeps) {
      step('目标机安装依赖(npm)');
      await remote(`cd ${shq(rel)} && npm install --omit=dev --no-audit --no-fund --registry=${NPM_REGISTRY}`);
      pass('依赖已安装');
    }
  } else {
    step('构建镜像');
    composeName = (await remote(`grep -m1 '^name:' ${shq(`${rel}/${composeFile}`)} | awk '{print $2}'`)).stdout.trim();
    for (const svc of ['app', 'nginx', 'migrate']) {
      await docker(`docker tag ${composeName}-${svc}:latest ${composeName}-${svc}:prev`, { allowFail: true });
    }
    await docker(`${compose} build`);
    pass(`镜像已构建(${composeName}-app / -nginx / -migrate)`);
  }

  // ---------------------------------------------------- 迁移检查
  step('迁移检查');
  const statusCmd = './node_modules/.bin/prisma migrate status --config server/prisma.config.ts';
  const status =
    mode === 'pm2'
      ? await remote(`cd ${shq(rel)} && ${statusCmd}`, { allowFail: true })
      : await docker(`${compose} run --rm --no-deps migrate ${statusCmd}`, { allowFail: true });
  const statusText = `${status.stdout}\n${status.stderr}`;
  if (!/up to date|have not yet been applied|No migration found/i.test(statusText)) {
    fail(`读取迁移状态失败(数据库可能连不上):\n${statusText.trim().split('\n').slice(-10).join('\n')}`);
  }
  const pending = release.migrations.filter((m) => statusText.includes(m) && /not yet been applied/i.test(statusText));
  if (pending.length === 0) pass('没有待执行的迁移');
  else {
    const risky = pending
      .map((m) => {
        const sql = fs.readFileSync(path.join(dir, 'server/prisma/migrations', m, 'migration.sql'), 'utf8');
        const hits = sql.split('\n').filter((l) => !l.trim().startsWith('--') && DESTRUCTIVE.test(l));
        return { m, hits };
      })
      .filter((x) => x.hits.length > 0);
    info(`待执行迁移 ${pending.length} 个: ${pending.join(', ')}`);
    const mustConfirm = risky.length > 0 || env === 'prod';
    if (mustConfirm && !args['confirm-migrations']) {
      const detail = risky.map((x) => `  ${x.m}\n${x.hits.map((h) => `      ${h.trim()}`).join('\n')}`).join('\n');
      needConfirm(
        'migrations',
        `${env} 环境将执行迁移: ${pending.join(', ')}${risky.length > 0 ? `\n其中包含删除类语句(不可逆):\n${detail}` : ''}\n` +
          '迁移只能向前,不能回滚。请用户确认后带 --confirm-migrations 重跑',
      );
    }
  }

  // ---------------------------------------------------- 执行迁移(首次部署灌种子)
  const initialized = (await remote(`test -f ${shq(`${envDir}/shared/.initialized`)} && echo yes || echo no`)).stdout.trim() === 'yes';
  step(`执行迁移${initialized ? '' : ' + 灌种子(首次部署)'}`);
  if (mode === 'pm2') {
    await remote(`cd ${shq(rel)} && ./node_modules/.bin/prisma migrate deploy --config server/prisma.config.ts${initialized ? '' : ' && node server/dist/seed.js'}`);
  } else {
    await docker(`${compose} run --rm --no-deps -e SKIP_SEED=${initialized ? 1 : 0} migrate`);
  }
  pass(pending.length > 0 ? `已执行 ${pending.length} 个迁移` : '迁移状态已确认');
  // 种子成功就记"已初始化",不等健康检查: 否则启动失败后重跑会再灌一次种子,而第一次生成的密码已经丢了
  if (!initialized) await remote(`touch ${shq(`${envDir}/shared/.initialized`)}`);

  // ---------------------------------------------------- 切换与启动
  step('切换版本并启动');
  const prevRel = (await remote(`readlink ${shq(`${envDir}/current`)} || true`)).stdout.trim();
  await remote(`ln -sfn ${shq(rel)} ${shq(`${envDir}/current`)}`);
  const pm2Name = `${name}-${env}`;
  if (mode === 'pm2') {
    const eco = `module.exports = { apps: [{ name: ${JSON.stringify(pm2Name)}, cwd: ${JSON.stringify(`${envDir}/current`)}, script: 'server/dist/main.js', time: true }] };\n`;
    await remote(`cat > ${shq(`${envDir}/shared/ecosystem.config.cjs`)} <<'__ECO__'\n${eco}__ECO__`);
    await remote(`pm2 startOrReload ${shq(`${envDir}/shared/ecosystem.config.cjs`)} --update-env && pm2 save`);
    if (!args['skip-nginx']) {
      const conf = nginxConf({ appPort, backendPort, root: `${envDir}/current/web/dist` });
      await remote(`cat > /etc/nginx/conf.d/${pm2Name}.conf <<'__NGX__'\n${conf}__NGX__\nnginx -t && (systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || nginx)`, sudoOpt);
    }
  } else {
    await docker(`${compose} up -d --no-build`);
  }

  // ---------------------------------------------------- 健康检查,失败回滚
  step('健康检查');
  const probeUrl = mode === 'pm2' && args['skip-nginx'] ? `http://127.0.0.1:${backendPort}/api/health` : `http://127.0.0.1:${appPort}/api/health`;
  const checkHealth = () => remote(
    `for i in $(seq 1 30); do if command -v curl >/dev/null; then code=$(curl -s -o /dev/null -w '%{http_code}' ${probeUrl}); else wget -qO /dev/null ${probeUrl} && code=200 || code=0; fi; [ "$code" = "200" ] && echo OK && exit 0; sleep 2; done; echo FAIL`,
    { allowFail: true },
  );
  const health = await checkHealth();
  const record = {
    project: name,
    env,
    host: t.host,
    port: t.port,
    user: t.user,
    hostKey: fingerprint,
    mode,
    baseDir: base,
    appPort,
    backendPort,
  };
  const releaseRecord = { id, commit: release.git.commit, branch: release.git.branch, at: new Date().toISOString(), migrations: pending };
  if (!health.stdout.includes('OK')) {
    warn('健康检查失败,回滚到上一版本');
    const logs =
      mode === 'pm2'
        ? await remote(`pm2 logs ${shq(pm2Name)} --lines 30 --nostream`, { allowFail: true })
        : await docker(`${compose} logs --tail 40 app`, { allowFail: true });
    process.stdout.write(`${`${logs.stdout}\n${logs.stderr}`.trim().replace(/^/gm, '    ')}\n`);
    if (prevRel) {
      await remote(`ln -sfn ${shq(prevRel)} ${shq(`${envDir}/current`)}`);
      if (mode === 'pm2') await remote(`pm2 reload ${shq(pm2Name)} --update-env`, { allowFail: true });
      else {
        for (const svc of ['app', 'nginx', 'migrate']) await docker(`docker tag ${composeName}-${svc}:prev ${composeName}-${svc}:latest`, { allowFail: true });
        await docker(`${compose} up -d --no-build`, { allowFail: true });
      }
      // 切回旧版本后要等它真正起来,不能切完就报"已回滚"
      const back = await checkHealth();
      if (back.stdout.includes('OK')) pass(`已回滚到 ${path.basename(prevRel)},旧版本健康检查通过(注意: 已执行的迁移不会回滚)`);
      else warn(`已切回 ${path.basename(prevRel)},但旧版本健康检查也没通过,线上可能不可用,需要人工介入`);
    } else info('这是首次部署,没有可回滚的版本');
    recordDeployment(record, { ...releaseRecord, status: 'failed-rolled-back' });
    conn.end();
    fail('部署失败。可在 skill 的 tmp/ 下写临时脚本排查,解决后把经验记进 LESSONS.md');
  }
  pass('健康检查通过');

  // ---------------------------------------------------- 收尾
  await remote(
    `cd ${shq(`${envDir}/releases`)} && ls -1t | grep -v -x ${shq(id)} | tail -n +${KEEP_RELEASES} | xargs -r rm -rf`,
    { allowFail: true },
  );
  recordDeployment(record, { ...releaseRecord, status: 'ok' });
  conn.end();

  process.stdout.write(
    `\n============================================================\n` +
      `  部署完成: ${name} [${env}]\n` +
      `  访问地址  http://${t.host}:${appPort}/\n` +
      `  健康检查  http://${t.host}:${appPort}/api/health\n` +
      `  版本      ${release.git.shortCommit}(${release.git.branch})${release.git.subject}\n` +
      `  方式      ${mode === 'pm2' ? `pm2 进程 ${pm2Name} + nginx` : `docker compose 项目 ${composeName}`}\n` +
      `  目录      ${envDir}/current -> releases/${id}\n` +
      `  迁移      ${pending.length > 0 ? pending.join(', ') : '无新迁移'}\n` +
      (initialized ? '' : `  管理员    admin,密码为 deploy/.env.${env} 的 SEED_ADMIN_PASSWORD\n`) +
      `============================================================\n`,
  );
};

/** pm2 方式的 nginx 站点:托管前端静态文件,/api 转发给本机后端。与 deploy/nginx.conf 同一套规则。 */
const nginxConf = ({ appPort, backendPort, root }) => `server {
    listen ${appPort};
    server_name _;
    client_max_body_size 1m;
    server_tokens off;
    gzip on;
    gzip_types text/plain text/css text/javascript application/javascript application/json image/svg+xml;

    location /api/ {
        proxy_pass http://127.0.0.1:${backendPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id $request_id;
    }

    root ${root};
    index index.html;
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }
    location = /index.html {
        add_header Cache-Control "no-store, must-revalidate" always;
    }
    location / {
        try_files $uri $uri/ /index.html;
    }
}
`;

const handlers = { probe: cmdProbe, deploy: cmdDeploy, status: cmdStatus };
const handler = handlers[command];
if (!handler) fail('用法: node deploy.mjs <probe|deploy|status> [参数],见文件头注释');
Promise.resolve(handler()).catch((e) => fail(e?.stack ?? String(e)));
