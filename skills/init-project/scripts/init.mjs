#!/usr/bin/env node
/**
 * init-project —— 用 skill 自带的模板源码包(assets/template.tar.gz)初始化一个新项目。零依赖,只需 Node >= 22.12 与 git。
 * 源码包由 pack.mjs 从模板仓库打出,不联网、不 clone,新项目没有任何远端。
 *
 * 用法:
 *   node init.mjs --check-ports
 *       探测端口段:跳过本机正在监听的段,也跳过 projects.json 里已分配的段,打印可用的段。
 *
 *   node init.mjs --list
 *       列出 projects.json 里登记过的项目(初始化时的决策记录)。
 *
 *   node init.mjs --name order-system --dir <绝对路径> --segment 72 \
 *       (--dev-db-url <连接串> | --dev-db-local) \
 *       [--title 订单系统] [--test-db-url <连接串>] [--prod-db-url <连接串>] \
 *       [--admin-password <密码>] [--skip-verify]
 *
 * 失败安全: 解包模板、改名、首次提交都在临时目录完成,成功后才写入目标目录。
 * 写入目标目录之后的步骤(装依赖 / 建表 / 验证)失败时,代码已经完整,进目录续跑即可。
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 配置用 .mjs 而不是 JSON: 每个字段都能写注释
const { default: CONFIG } = await import(pathToFileURL(path.join(SKILL_ROOT, 'config.mjs')).href);
const isWindows = process.platform === 'win32';

// ============================================================ 输出
let stepNo = 0;
const step = (title) => process.stdout.write(`\n[${++stepNo}] ${title}\n`);
const pass = (msg) => process.stdout.write(`  [PASS] ${msg}\n`);
const info = (msg) => process.stdout.write(`  [INFO] ${msg}\n`);
const warn = (msg) => process.stdout.write(`  [WARN] ${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`  [FAIL] ${msg}\n`);
  process.exit(1);
};

/**
 * 只有 pnpm 在 Windows 上是 .cmd 脚本,必须经 shell 调用;git / docker 是真正的可执行文件,
 * 走 shell 反而会把带空格的参数(如提交信息)拆成多个参数。
 */
const needsShell = (cmd) => isWindows && cmd === 'pnpm';

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', shell: needsShell(cmd), ...opts });

/** 跑一条命令并把输出直接给用户看;失败即中止。 */
const runVisible = (cmd, args, cwd, what) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: needsShell(cmd), env: { ...process.env, CI: 'true' } });
  if (r.status !== 0) fail(`${what}失败(exit=${r.status})。代码已在 ${cwd},修好原因后进目录续跑,不要重新初始化`);
};

// ============================================================ 模板解包
//
// 模板是 skill 自带的源码包,不用 git clone: 新项目与模板仓库没有任何关联(没有远端、没有历史),不可能误推到模板仓库。
// 只依赖 Node 与 git: gzip 用 node:zlib,tar 用纯 Node 解包,沙箱镜像里有没有 tar 都不影响。

const TEMPLATE_ASSET = path.join(SKILL_ROOT, 'assets', 'template.tar.gz');

const TAR_BLOCK = 512;
const tarString = (buf, start, len) => buf.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
const tarOctal = (buf, start, len) => parseInt(tarString(buf, start, len).trim() || '0', 8);

/**
 * 解包 tar(ustar + pax,即 git archive 的格式)到 dest,去掉第一层目录(pack.mjs 打的 template/)。
 * 支持普通文件、目录、软链接与 pax 长路径;保留可执行位(*.sh)。
 */
const untar = (tar, dest) => {
  let offset = 0;
  let paxPath = null;
  let files = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = tarOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK + size);
    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (type === 'g') continue; // 全局 pax 头(git archive 在这里写提交号),不是文件
    if (type === 'x') {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null;
      continue;
    }
    const prefix = tarString(header, 345, 155);
    const full = paxPath ?? (prefix ? `${prefix}/${tarString(header, 0, 100)}` : tarString(header, 0, 100));
    paxPath = null;
    const rel = full.split('/').slice(1).join('/');
    if (!rel) continue;
    const target = path.join(dest, rel);
    if (!path.resolve(target).startsWith(path.resolve(dest) + path.sep)) throw new Error(`归档里有越界路径: ${full}`);

    if (type === '5') fs.mkdirSync(target, { recursive: true });
    else if (type === '2') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(tarString(header, 157, 100), target);
    } else if (type === '0') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, { mode: tarOctal(header, 100, 8) & 0o777 });
      files += 1;
    }
  }
  return files;
};

/** git archive 生成的包在全局 pax 头里记录提交号;读不到返回 null。 */
const tarCommit = (tar) => {
  const r = spawnSync('git', ['get-tar-commit-id'], { input: tar.subarray(0, TAR_BLOCK * 4), encoding: 'utf8' });
  return r.status === 0 && /^[0-9a-f]{40}$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
};

// ============================================================ 参数
const FLAGS = new Set(['check-ports', 'list', 'dev-db-local', 'skip-verify']);
const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) fail(`无法识别的参数: ${token}`);
    const key = token.slice(2);
    if (FLAGS.has(key)) {
      out[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`参数 --${key} 缺少取值`);
    out[key] = value;
    i += 1;
  }
  return out;
};

// ============================================================ 决策登记 projects.json
/**
 * 每次初始化的决策都记在这里: 名称、端口段、schema、数据库地址、模板版本、状态。
 *
 * 为什么要记: 端口探测只能看"此刻有没有程序在监听",项目没启动时它的段看起来是空的,
 * 会被重复分配。登记过的段、名称、目录一律视为已占用。
 * 不记密码: 连接串只留 主机:端口/库名。
 */
const REGISTRY = path.join(SKILL_ROOT, 'projects.json');

const loadRegistry = () => (fs.existsSync(REGISTRY) ? JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) : { projects: [] });

const saveRegistry = (reg) => fs.writeFileSync(REGISTRY, `${JSON.stringify(reg, null, 2)}\n`);

/** 按项目名新增或更新一条记录。 */
const upsertProject = (record) => {
  const reg = loadRegistry();
  const i = reg.projects.findIndex((p) => p.name === record.name);
  if (i >= 0) reg.projects[i] = { ...reg.projects[i], ...record };
  else reg.projects.push(record);
  saveRegistry(reg);
};

/** 连接串去掉账号密码,只留 主机:端口/库名。 */
const describeDb = (url) => {
  const u = new URL(url);
  return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
};

const listProjects = () => {
  const { projects } = loadRegistry();
  if (projects.length === 0) {
    process.stdout.write('还没有登记过的项目\n');
    return;
  }
  for (const p of projects) {
    process.stdout.write(
      `${p.name}(${p.title})  段 ${p.ports.segment}  状态 ${p.status}  ${p.createdAt.slice(0, 10)}\n` +
        `  目录 ${p.dir}\n  开发库 ${p.database.dev.host} schema ${p.database.dev.schema}` +
        `  测试 ${p.database.test.configured ? '已配' : '未配'}  生产 ${p.database.prod.configured ? '已配' : '未配'}\n`,
    );
  }
};

// ============================================================ 端口
const MIN_SEGMENT = 20;
const MAX_SEGMENT = 99; // 端口是四位数: <段>01 ~ <段>04;e2e = 后端 + 1000,最大 10901

/** 一个段占用的端口: 后端 / 前端 / 本机库 / 测试环境入口,外加 e2e(后端 + 1000)。 */
const portsOf = (segment) => [1, 2, 3, 4].map((n) => segment * 100 + n).concat(segment * 100 + 1 + 1000);

const isPortFree = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });

const busyPortsOf = async (segment) => {
  const busy = [];
  for (const p of portsOf(segment)) if (!(await isPortFree(p))) busy.push(p);
  return busy;
};

const checkPorts = async () => {
  // 从模板段的下一个开始往上找,到顶再从最小段找起;跳过模板自己的段(本机多半在跑模板)
  const start = CONFIG.templatePortSegment + 1;
  const order = [];
  for (let s = start; s <= MAX_SEGMENT; s += 1) order.push(s);
  for (let s = MIN_SEGMENT; s < CONFIG.templatePortSegment; s += 1) order.push(s);
  const registered = new Set(loadRegistry().projects.map((p) => p.ports.segment));
  const free = [];
  for (const s of order) {
    if (free.length >= 5) break;
    if (registered.has(s)) continue;
    if ((await busyPortsOf(s)).length === 0) free.push(s);
  }
  if (registered.size > 0) process.stdout.write(`已登记(跳过): ${[...registered].sort().join(', ')}\n`);
  process.stdout.write(`可用端口段(前 5 个): ${free.join(', ')}\n`);
  for (const s of free.slice(0, 3)) {
    process.stdout.write(`  ${s}: 后端 ${s}01 / 前端 ${s}02 / 本机库 ${s}03 / 测试入口 ${s}04 / e2e ${s + 10}01\n`);
  }
};

// ============================================================ 校验
const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const TITLE_BAD = /["'`:#\\<>]/;

const validate = (a) => {
  if (!a.name || !NAME_RE.test(a.name) || a.name.length > 32) {
    fail('--name 必填: 小写字母开头,只含小写字母、数字、单个连字符,最长 32,如 order-system');
  }
  if (a.name === CONFIG.templateName) fail(`--name 不能与模板同名(${CONFIG.templateName})`);
  const registry = loadRegistry().projects;
  const sameName = registry.find((p) => p.name === a.name);
  if (sameName) fail(`项目名 ${a.name} 已登记过(目录 ${sameName.dir})。换一个名字,或先从 projects.json 删除那条记录`);
  if (!a.dir) fail('--dir 必填: 目标目录的绝对路径');
  const dir = path.resolve(a.dir);
  if (!path.isAbsolute(a.dir)) fail(`--dir 必须是绝对路径,当前是 ${a.dir}`);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) fail(`目标目录已存在且非空: ${dir}(不会替你删除,请换目录或自行清空)`);

  const segment = Number(a.segment);
  if (!Number.isInteger(segment) || segment < MIN_SEGMENT || segment > MAX_SEGMENT) {
    fail(`--segment 必填: ${MIN_SEGMENT}~${MAX_SEGMENT} 的整数,如 72 表示 7201~7204。先用 --check-ports 看哪些可用`);
  }
  const sameSegment = registry.find((p) => p.ports.segment === segment);
  if (sameSegment) fail(`端口段 ${segment} 已分配给项目 ${sameSegment.name}。用 --check-ports 换一个段`);
  const sameDir = registry.find((p) => path.resolve(p.dir) === dir);
  if (sameDir) fail(`目录 ${dir} 已登记给项目 ${sameDir.name}`);

  if (Boolean(a['dev-db-url']) === Boolean(a['dev-db-local'])) {
    fail('开发库必须二选一: --dev-db-url <连接串>(用现成的 PG)或 --dev-db-local(本机 docker 起一个)');
  }
  for (const key of ['dev-db-url', 'test-db-url', 'prod-db-url']) {
    if (!a[key]) continue;
    let u;
    try {
      u = new URL(a[key]);
    } catch {
      fail(`--${key} 不是合法的连接串`);
    }
    if (!['postgres:', 'postgresql:'].includes(u.protocol)) fail(`--${key} 必须是 postgresql:// 开头`);
    if (u.searchParams.has('schema')) fail(`--${key} 不要带 ?schema=,schema 由脚本按 <项目>_dev/_test/_prod 生成`);
  }

  const title = a.title ?? a.name;
  if (TITLE_BAD.test(title) || title.length > 40) fail('--title 最长 40,不能含引号、冒号、井号、反斜杠、尖括号');

  const snake = a.name.replace(/-/g, '_');
  return {
    name: a.name,
    snake,
    title,
    dir,
    segment,
    devDbUrl: a['dev-db-url'],
    devDbLocal: Boolean(a['dev-db-local']),
    testDbUrl: a['test-db-url'],
    prodDbUrl: a['prod-db-url'],
    adminPassword: a['admin-password'] ?? 'admin12345',
    skipVerify: Boolean(a['skip-verify']),
  };
};

// ============================================================ 改名
const TEXT_SKIP_DIRS = new Set(['.git', 'node_modules']);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return TEXT_SKIP_DIRS.has(e.name) ? [] : walk(p);
    return [p];
  });

/** 按顺序替换: 先端口,再数据库标识符(下划线形式),再标题,最后其余的项目名(连字符形式)。 */
const buildReplacers = (o) => {
  const t = CONFIG.templateName;
  const T = CONFIG.templateTitle;
  const seg = String(CONFIG.templatePortSegment);
  return [
    [new RegExp(`\\b${seg}(0[1-9])\\b`, 'g'), `${o.segment}$1`],
    [new RegExp(`\\b${Number(seg) + 10}01\\b`, 'g'), `${o.segment + 10}01`],
    [new RegExp(`${seg}xx`, 'g'), `${o.segment}xx`],
    [new RegExp(`:-${t}\\}`, 'g'), `:-${o.snake}}`],
    [new RegExp(`(POSTGRES_(?:USER|DB)\\s*[:=]\\s*)${t}\\b`, 'g'), `$1${o.snake}`],
    [new RegExp(`${t}_`, 'g'), `${o.snake}_`],
    [new RegExp(`_${t}\\b`, 'g'), `_${o.snake}`],
    [new RegExp(T, 'g'), o.title],
    [new RegExp(t, 'g'), o.name],
  ];
};

const rewriteTree = (root, o) => {
  const replacers = buildReplacers(o);
  let changed = 0;
  for (const file of walk(root)) {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) continue;
    const before = buf.toString('utf8');
    let after = before;
    for (const [re, to] of replacers) after = after.replace(re, to);
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed += 1;
    }
  }
  return changed;
};

/** 模板自带、但不属于新项目的内容。 */
const stripTemplateOnly = (root) => {
  const removed = [];
  for (const f of fs.readdirSync(path.join(root, 'docs'))) {
    if (f.includes('AICoding基座设计')) {
      fs.rmSync(path.join(root, 'docs', f));
      removed.push(`docs/${f}`);
    }
  }
  const readme = path.join(root, 'README.md');
  const text = fs.readFileSync(readme, 'utf8').replace(/\n> 原名 keel[^\n]*\n/, '\n');
  fs.writeFileSync(readme, text);
  return removed;
};

const assertNoTemplateLeft = (root, o) => {
  const leftovers = [];
  const portRe = new RegExp(`\\b${CONFIG.templatePortSegment}0[1-4]\\b`);
  for (const file of walk(root)) {
    if (file.endsWith('pnpm-lock.yaml')) continue;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) continue;
    const s = buf.toString('utf8');
    if (new RegExp(CONFIG.templateName, 'i').test(s)) leftovers.push(`${path.relative(root, file)}: 仍含模板名`);
    if (o.segment !== CONFIG.templatePortSegment && portRe.test(s)) leftovers.push(`${path.relative(root, file)}: 仍含模板端口`);
  }
  if (leftovers.length > 0) fail(`改名不完整,模板可能已变更(不要改正则绕过,把下列信息交给用户):\n    ${leftovers.join('\n    ')}`);
};

// ============================================================ 环境文件
const setEnvLine = (text, key, value) => {
  const line = `${key}=${value}`;
  const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
  if (!re.test(text)) fail(`.env.example 里找不到 ${key},模板可能已变更`);
  return text.replace(re, line);
};

const quote = (v) => `"${v.replace(/"/g, '\\"')}"`;

const writeDevEnv = (root, o, devUrl) => {
  let text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  text = setEnvLine(text, 'PORT', `${o.segment}01`);
  text = setEnvLine(text, 'WEB_PORT', `${o.segment}02`);
  text = setEnvLine(text, 'DATABASE_URL', quote(devUrl));
  text = setEnvLine(text, 'DATABASE_SCHEMA', `${o.snake}_dev`);
  text = setEnvLine(text, 'JWT_SECRET', randomBytes(48).toString('base64url'));
  text = setEnvLine(text, 'SEED_ADMIN_PASSWORD', o.adminPassword);
  fs.writeFileSync(path.join(root, '.env'), text.replace(/^# 复制成 \.env[^\n]*\n/, '# 本机开发配置,由 init-project 生成,不入库。\n'));
};

const writeStageEnv = (root, o, stage, url) => {
  const file = path.join(root, 'deploy', `.env.${stage}`);
  fs.writeFileSync(
    file,
    `# ${stage === 'test' ? '测试' : '生产'}环境数据库,由 init-project 写入,不入库(含密码)。部署 skill 读取这里。\n` +
      `DATABASE_URL=${quote(url)}\nDATABASE_SCHEMA=${o.snake}_${stage}\n`,
  );
  return path.relative(root, file).replace(/\\/g, '/');
};

/** 测试 / 生产连接串含密码: 模板的 .gitignore 已忽略,这里再兜底一次,确保不会被提交。 */
const ensureIgnored = (root) => {
  const gi = path.join(root, '.gitignore');
  let text = fs.readFileSync(gi, 'utf8');
  for (const rule of ['.env.test', '.env.prod']) {
    if (!new RegExp(`^${rule.replace('.', '\\.')}$`, 'm').test(text)) text += `\n${rule}\n`;
  }
  fs.writeFileSync(gi, text);
};

// ============================================================ 主流程
const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args['check-ports']) {
    await checkPorts();
    return;
  }
  if (args.list) {
    listProjects();
    return;
  }
  const o = validate(args);

  step('环境预检');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) fail(`需要 Node >= 22.12,当前 ${process.versions.node}`);
  pass(`Node ${process.versions.node}`);
  for (const tool of ['git', 'pnpm']) {
    if (run(tool, ['--version']).status !== 0) fail(`找不到 ${tool}`);
    pass(`${tool} 可用`);
  }
  if (o.devDbLocal && run('docker', ['version', '--format', '{{.Server.Version}}']).status !== 0) {
    fail('--dev-db-local 需要能运行 docker(沙箱 / 容器里不可用),改用 --dev-db-url 填现成的 PG');
  }
  if (!fs.existsSync(TEMPLATE_ASSET)) fail(`缺少模板源码包 ${TEMPLATE_ASSET}: skill 不完整,在模板仓库里运行 scripts/pack.mjs 生成`);
  pass('模板源码包 assets/template.tar.gz');
  const busy = await busyPortsOf(o.segment);
  if (busy.length > 0) fail(`端口段 ${o.segment} 有端口被占用: ${busy.join(', ')}。用 --check-ports 换一个段`);
  pass(`端口段 ${o.segment} 空闲(${portsOf(o.segment).join(' / ')})`);
  const gitName = run('git', ['config', 'user.name']).stdout.trim();
  const gitEmail = run('git', ['config', 'user.email']).stdout.trim();
  if (!gitName || !gitEmail) fail('git 未配置 user.name / user.email,首次提交需要它们');
  pass(`提交身份 ${gitName} <${gitEmail}>`);

  step('解包模板');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'init-project-'));
  const src = path.join(work, 'src');
  const tar = zlib.gunzipSync(fs.readFileSync(TEMPLATE_ASSET));
  const files = untar(tar, src);
  if (files === 0) fail('模板源码包里没有文件,在模板仓库里重新运行 scripts/pack.mjs');
  const fullSha = tarCommit(tar);
  const sha = fullSha ? fullSha.slice(0, 7) : 'unknown';
  pass(`模板版本 ${sha},${files} 个文件`);

  step('改名与端口');
  const removed = stripTemplateOnly(src);
  const changed = rewriteTree(src, o);
  assertNoTemplateLeft(src, o);
  pass(`改写 ${changed} 个文件: ${CONFIG.templateName} -> ${o.name} / ${o.snake},标题 ${o.title},端口 ${o.segment}xx`);
  if (removed.length > 0) info(`移除模板专属文件: ${removed.join(', ')}`);

  step('首次提交');
  ensureIgnored(src);
  for (const [cmd, a] of [
    ['git', ['init', '-q', '-b', 'main']],
    ['git', ['add', '-A']],
    ['git', ['commit', '-q', '-m', `chore: 从 ${CONFIG.templateName} 模板初始化(${sha})`]],
  ]) {
    const r = run(cmd, a, { cwd: src });
    if (r.status !== 0) fail(`${cmd} ${a.join(' ')} 失败: ${r.stderr.trim()}`);
  }
  // 新项目必须是独立仓库: 任何远端都可能把业务代码推到模板仓库
  const remotes = run('git', ['remote'], { cwd: src }).stdout.trim();
  if (remotes) fail(`新仓库不应有远端,发现: ${remotes}`);
  pass('git 仓库已初始化(独立仓库,没有远端),分支 main,已提交');

  step(`写入目标目录 ${o.dir}`);
  fs.mkdirSync(o.dir, { recursive: true });
  fs.cpSync(src, o.dir, { recursive: true });
  fs.rmSync(work, { recursive: true, force: true });
  pass('代码已写入');

  step('环境配置');
  const devUrl = o.devDbLocal
    ? `postgresql://${o.snake}:${o.snake}_dev_password@127.0.0.1:${o.segment}03/${o.snake}_dev`
    : o.devDbUrl;
  writeDevEnv(o.dir, o, devUrl);
  pass(`.env: 端口 ${o.segment}01/${o.segment}02,schema ${o.snake}_dev`);
  const pending = [];
  for (const [stage, url] of [['test', o.testDbUrl], ['prod', o.prodDbUrl]]) {
    if (url) pass(`${writeStageEnv(o.dir, o, stage, url)}: schema ${o.snake}_${stage}(只保存,未连接)`);
    else pending.push(stage);
  }
  const ignored = run('git', ['status', '--porcelain'], { cwd: o.dir }).stdout.trim();
  if (ignored !== '') fail(`环境文件没有被 git 忽略,存在泄漏风险:\n${ignored}`);
  pass('环境文件均已被 git 忽略');

  const stageRecord = (stage, url) => ({
    configured: Boolean(url),
    host: url ? describeDb(url) : null,
    schema: `${o.snake}_${stage}`,
  });
  upsertProject({
    name: o.name,
    title: o.title,
    dir: o.dir,
    ports: {
      segment: o.segment,
      server: o.segment * 100 + 1,
      web: o.segment * 100 + 2,
      localDb: o.segment * 100 + 3,
      testEntry: o.segment * 100 + 4,
      e2e: o.segment * 100 + 1001,
    },
    database: {
      dev: { ...stageRecord('dev', devUrl), local: o.devDbLocal },
      test: stageRecord('test', o.testDbUrl),
      prod: stageRecord('prod', o.prodDbUrl),
    },
    template: { archive: 'assets/template.tar.gz', commit: fullSha ?? sha },
    createdAt: new Date().toISOString(),
    status: 'initializing',
  });
  pass(`决策已登记到 ${path.relative(path.dirname(SKILL_ROOT), REGISTRY).replace(/\\/g, '/')}(状态: 初始化中)`);

  step('安装依赖');
  runVisible('pnpm', ['install', '--frozen-lockfile'], o.dir, '安装依赖');

  if (o.devDbLocal) {
    step(`启动本机开发库(${o.name}-dev-postgres,端口 ${o.segment}03)`);
    runVisible('pnpm', ['db', 'up'], o.dir, '启动本机开发库');
  }

  step('建表与种子');
  runVisible('pnpm', ['db', 'deploy'], o.dir, '应用迁移');
  runVisible('pnpm', ['db', 'seed'], o.dir, '灌种子');

  if (o.skipVerify) {
    step('跳过验证(--skip-verify)');
    warn('尚未运行 pnpm verify,交付前必须补跑');
  } else {
    step('全量验证 pnpm verify');
    runVisible('pnpm', ['verify'], o.dir, '验证');
  }
  upsertProject({ name: o.name, status: o.skipVerify ? 'unverified' : 'ready' });

  process.stdout.write(
    `\n============================================================\n` +
      `  初始化完成: ${o.title}(${o.name})\n` +
      `  目录      ${o.dir}\n` +
      `  启动      cd ${o.dir} && pnpm dev\n` +
      `  前端      http://localhost:${o.segment}02/\n` +
      `  后端      http://localhost:${o.segment}01/api/health\n` +
      `  账号      admin / ${o.adminPassword}${o.adminPassword === 'admin12345' ? '(默认密码,上线前必须改)' : ''}\n` +
      `  开发库    schema ${o.snake}_dev\n` +
      `============================================================\n`,
  );
  for (const stage of pending) {
    warn(
      `${stage === 'test' ? '测试' : '生产'}环境数据库未配置。部署前在 deploy/.env.${stage} 写入:\n` +
        `         DATABASE_URL="postgresql://..."\n         DATABASE_SCHEMA=${o.snake}_${stage}`,
    );
  }
};

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
