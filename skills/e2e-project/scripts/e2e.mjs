#!/usr/bin/env node
/**
 * e2e-project: AI 按用户意图用 playwright-cli 做端到端验证,留证据、出报告、由用户验收后归档,并沉淀回归脚本。
 *
 *   doctor  [--project-dir P] [--base-url URL] [--install]       环境检查(pwcli、回归用浏览器、被测地址)
 *   start   --project-dir P --base-url URL --name <英文短名> --plan <plan.json> [--headed]
 *   act     --run <运行目录> --scenario <场景id> [--why "意图"] -- <pwcli 参数...>
 *   check   --run <运行目录> --scenario <场景id> --expect "..." --actual "..." --result pass|fail [--assert "<expect 代码>"]
 *   finish  --run <运行目录>                                       收尾: 停 trace、关浏览器、生成报告与回归脚本草稿
 *   regress --run <运行目录> --spec e2e/ui/<名>.spec.ts            跑回归脚本,结果写进报告
 *   verdict --run <运行目录> --result pass|fail [--note "..."]     记录用户验收结论并归档到 e2e/archive/
 *   list    [--project-dir P]                                      归档记录
 *
 * 密码等敏感值: 参数里写 {{变量名}},真实值从环境变量(及项目根 .env)取;记录、快照、脚本里只出现变量名。
 * 退出码: 0 成功;1 失败;3 需要用户确认(输出 NEED_CONFIRM <类型>)。
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { consoleErrors, coreOf, failedRequests, findCli, findSandboxCli, parseAction, projectCliVersion, pw, useCli } from './lib/pw.mjs';
import { applyFontsConf, FONTS_CONF, findCjkFonts, installFonts, needsFontCheck } from './lib/fonts.mjs';
import { buildReport, readSteps, summarize } from './lib/report.mjs';

// ------------------------------------------------------------------ 参数与输出

const FLAGS = new Set(['install', 'headed']);

const parseArgs = (argv) => {
  const sep = argv.indexOf('--');
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const args = { _: [], rest: sep === -1 ? [] : argv.slice(sep + 1) };
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (!a.startsWith('--')) args._.push(a);
    else if (FLAGS.has(a.slice(2))) args[a.slice(2)] = true;
    else args[a.slice(2)] = own[++i];
  }
  return args;
};

const args = parseArgs(process.argv.slice(2));
// 调用方用 | head 只读前几行时管道会提前关闭,继续写 stdout 会抛 EPIPE;此时安静退出,不污染输出
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});
// 装过中文字体时,让 pwcli 与回归测试的浏览器都用上(见 lib/fonts.mjs)
applyFontsConf();
const out = (line) => process.stdout.write(`${line}\n`);
const fail = (msg) => {
  out(`[FAIL] ${msg}`);
  process.exit(1);
};
const needConfirm = (kind, msg) => {
  out(`\nNEED_CONFIRM ${kind}\n${msg}`);
  process.exit(3);
};
const required = (name) => args[name] ?? fail(`缺少参数 --${name}`);

// 不进回归脚本的命令: 只读、取证或会话管理类
const NON_REPLAY = new Set([
  'snapshot', 'screenshot', 'console', 'requests', 'request', 'find', 'generate-locator', 'eval', 'tab-list',
  'tracing-start', 'tracing-stop', 'video-start', 'video-stop', 'state-save', 'state-load', 'highlight', 'close',
]);
const ARCHIVE_SKIP = new Set(['.playwright-cli', '.playwright', 'state.json']);
const SECRET_TOKEN = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

// ------------------------------------------------------------------ 工具

const now = () => new Date().toISOString();
const pad = (n) => String(n).padStart(3, '0');
const stamp = () => {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const git = (dir, cmd) => {
  try {
    return execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const loadProjectEnv = (projectDir) => {
  const file = path.join(projectDir, '.env');
  // loadEnvFile 不覆盖已存在的环境变量: 命令行显式给的值优先
  if (fs.existsSync(file)) process.loadEnvFile(file);
};

/** {{NAME}} 换成真实值;返回真实参数与用到的 [名, 值]。 */
const resolveSecrets = (list) => {
  const used = new Map();
  const real = list.map((a) =>
    a.replace(SECRET_TOKEN, (_, name) => {
      const value = process.env[name];
      if (value === undefined || value === '') fail(`环境变量 ${name} 未设置(参数里引用了 {{${name}}})`);
      used.set(name, value);
      return value;
    }),
  );
  return { real, used: [...used] };
};

/** 记录前脱敏: 代码里的字面量换成 process.env[...],其余文本换成 {{NAME}}。 */
const maskCode = (code, used) =>
  used.reduce((c, [name, value]) => c.split(`'${value}'`).join(`process.env['${name}']!`).split(`"${value}"`).join(`process.env['${name}']!`).split(value).join(`{{${name}}}`), code);
const maskText = (text, used) => used.reduce((t, [name, value]) => t.split(value).join(`{{${name}}}`), text ?? '');

// ------------------------------------------------------------------ 运行目录

const openRun = () => {
  const runDir = path.resolve(required('run'));
  if (!fs.existsSync(path.join(runDir, 'meta.json'))) fail(`${runDir} 不是 e2e 运行目录(没有 meta.json)`);
  const meta = readJson(path.join(runDir, 'meta.json'));
  loadProjectEnv(meta.projectDir);
  // 用 start 时选定的那一份 playwright-cli,整次运行不换
  if (meta.cli?.source === 'sandbox') useCli(meta.cli.entry);
  else if (findCli(meta.projectDir) === null) fail(`项目 ${meta.projectDir} 里没有 playwright-cli,先 pnpm install`);
  const statePath = path.join(runDir, 'state.json');
  return { runDir, meta, plan: readJson(path.join(runDir, 'plan.json')), state: readJson(statePath), saveState: (s) => writeJson(statePath, s) };
};

const appendStep = (runDir, record) => fs.appendFileSync(path.join(runDir, 'steps.jsonl'), `${JSON.stringify(record)}\n`);

/** 每一步之后取证: 截图、快照(脱敏后保存)、当前页地址、相对上一步新增的控制台错误与失败请求。 */
const SETTLE_MS = 800;

const capture = (run, seq, stepUsed) => {
  const { runDir, meta, state } = run;
  state.secretNames = [...new Set([...(state.secretNames ?? []), ...stepUsed.map(([n]) => n)])];
  const used = state.secretNames.filter((n) => process.env[n]).map((n) => [n, process.env[n]]);
  // 点击后的跳转、接口请求是异步的,稍等再取证,否则截到的是跳转前的页面
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SETTLE_MS);
  const shot = `shots/${pad(seq)}.png`;
  const snap = `snapshots/${pad(seq)}.yml`;
  const shotOk = pw(runDir, meta.session, ['screenshot', `--filename=${shot}`]).code === 0 && fs.existsSync(path.join(runDir, shot));
  const snapOut = pw(runDir, meta.session, ['snapshot', `--filename=${snap}`]);
  const snapPath = path.join(runDir, snap);
  if (fs.existsSync(snapPath)) fs.writeFileSync(snapPath, maskText(fs.readFileSync(snapPath, 'utf8'), used));
  const page = parseAction(snapOut.out);
  const errors = consoleErrors(runDir, meta.session);
  const requests = failedRequests(runDir, meta.session);
  // 同一页面上的记录只增不减: 上一步的列表是前缀就取新增部分;不是前缀说明页面刷新过,整份都是新的。
  // 不能按文本去重,同一个请求失败两次是两条记录
  const fresh = (list, prev) => (prev.length <= list.length && prev.every((l, i) => list[i] === l) ? list.slice(prev.length) : list);
  const result = {
    url: page.url,
    title: page.title,
    screenshot: shotOk ? shot : null,
    snapshot: fs.existsSync(snapPath) ? snap : null,
    newConsoleErrors: fresh(errors, state.prevConsole).map((l) => maskText(l, used)),
    newFailedRequests: fresh(requests, state.prevRequests).map((l) => maskText(l, used)),
  };
  state.prevConsole = errors;
  state.prevRequests = requests;
  return result;
};

const scenarioOf = (plan) => {
  const id = required('scenario');
  if (!plan.scenarios.some((s) => s.id === id)) fail(`场景 ${id} 不在 plan.json 里(有: ${plan.scenarios.map((s) => s.id).join(', ')})`);
  return id;
};

// ------------------------------------------------------------------ 命令

/** 国内下载浏览器很慢;这个镜像在沙箱实测可用。只作为建议,由用户决定是否使用。 */
const MIRROR_HINT = 'PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright';

/**
 * 决定用哪一份 playwright-cli。
 *
 * 以项目依赖为准(e2e/package.json + lockfile,与 @playwright/test 同一个内核)。
 * 沙箱若内置了一份(以后镜像可能预装)且版本或内核与项目不同,必须由用户选择,不替用户决定:
 * 版本不同意味着浏览器版本可能不同,混用会出现"导航正常、点击输入静默失效"。
 * 选择通过 --use-cli project|sandbox 传入,start 时记进 meta.cli,之后每一步都用同一份。
 */
const resolveCli = (projectDir, { quiet = false } = {}) => {
  const say = (line) => !quiet && out(line);
  const entry = findCli(projectDir);
  const core = coreOf(projectDir, '@playwright/cli');
  const testCore = coreOf(projectDir, '@playwright/test');
  if (entry === null || core === null || testCore === null) {
    fail('项目里缺少 @playwright/cli 或 @playwright/test: 先在项目根目录执行 pnpm install(两者是 e2e/package.json 的开发依赖)');
  }
  // 项目内两个包的内核必须相同,否则探索与回归用的是两套浏览器
  if (core.version !== testCore.version) {
    fail(
      `项目里 playwright-cli 与 @playwright/test 的内核版本不一致: ${core.version} / ${testCore.version}。\n` +
        '    改 e2e/package.json,把 @playwright/test 锁到与 playwright-cli 依赖的 playwright-core 相同的版本号(见 e2e/README.md)',
    );
  }
  const project = { source: 'project', entry, version: projectCliVersion(projectDir), core };
  say(`[PASS] 项目锁定 playwright-cli ${project.version},与 @playwright/test 共用内核 ${core.version}`);

  const sandbox = findSandboxCli();
  if (sandbox === null) {
    say('[INFO] 沙箱没有内置 playwright-cli,使用项目依赖里的版本');
    return { chosen: project, testCore };
  }
  const sameCore = sandbox.core?.version === core.version;
  if (sandbox.version === project.version && sameCore) {
    say(`[PASS] 沙箱内置 playwright-cli ${sandbox.version} 与项目一致`);
    return { chosen: project, testCore };
  }

  const choice = args['use-cli'];
  if (choice === undefined) {
    needConfirm(
      'cli-version',
      `沙箱内置的 playwright-cli 与项目锁定的版本不一致:\n` +
        `  项目: ${project.version}(内核 ${core.version},浏览器 ${core.chromium.join(' / ')})\n` +
        `  沙箱: ${sandbox.version}(内核 ${sandbox.core?.version ?? '读不到'},浏览器 ${sandbox.core?.chromium.join(' / ') ?? '未知'})  ${sandbox.entry}\n` +
        '请问用户用哪一个:\n' +
        '  --use-cli project  用项目锁定的版本(推荐: 与回归测试同一内核,只需一套浏览器)\n' +
        '  --use-cli sandbox  用沙箱内置版本(内核不同时,探索与回归要用两套浏览器)\n' +
        '  若希望以后统一用沙箱的版本: 改 e2e/package.json 把两个包升到沙箱对应的版本(见 e2e/README.md)',
    );
  }
  if (choice === 'project') {
    say(`[INFO] 按用户选择使用项目版本 ${project.version}`);
    return { chosen: project, testCore };
  }
  if (choice !== 'sandbox') fail('--use-cli 只能是 project 或 sandbox');
  if (sandbox.core === null) fail(`读不到沙箱内置 playwright-cli 的内核(${sandbox.entry}),无法确认它要的浏览器版本`);
  useCli(sandbox.entry);
  say(`[WARN] 按用户选择使用沙箱内置版本 ${sandbox.version}${sameCore ? '' : ',与回归测试内核不同,需要两套浏览器'}`);
  return { chosen: { source: 'sandbox', ...sandbox }, testCore };
};

const doctor = async () => {
  const projectDir = path.resolve(args['project-dir'] ?? '.');
  const { chosen, testCore } = resolveCli(projectDir);

  const missing = [];
  const browsersDir =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
        : path.join(process.env.HOME ?? '', '.cache', 'ms-playwright'));
  // 按内核要求的准确版本判断,目录里有别的版本不算数;绝不用软链把别的版本冒充成所需版本
  const installed = (dir) => fs.existsSync(path.join(browsersDir, dir, 'INSTALLATION_COMPLETE'));
  // 回归测试(项目内核)要的浏览器
  const testAbsent = testCore.chromium.filter((d) => !installed(d));
  if (testAbsent.length > 0) {
    missing.push({ item: `浏览器 ${testAbsent.join(' / ')}`, cmd: 'pnpm --filter @app/e2e exec playwright install chromium' });
  } else out(`[PASS] 浏览器 ${testCore.chromium.join(' / ')}(${browsersDir})`);
  // 用户选了内核不同的沙箱版本时,它要的浏览器另外装,用它自己的安装命令
  // Linux 精简镜像常常没有字体: 文字渲染成空白方块,浏览器处理输入时还可能崩溃
  if (needsFontCheck()) {
    const cjk = findCjkFonts();
    if (cjk.length === 0) {
      missing.push({ item: '中文字体(思源黑体常规与粗体,下载约 54MB,装到用户目录)', cmd: '从 npm 镜像下载 @expo-google-fonts/noto-sans-sc', action: installFonts });
    } else out(`[PASS] 中文字体 ${path.basename(cjk[0])} 等 ${cjk.length} 个`);
  }
  if (chosen.source === 'sandbox' && chosen.core.version !== testCore.version) {
    const cliAbsent = chosen.core.chromium.filter((d) => !installed(d));
    if (cliAbsent.length > 0) {
      missing.push({ item: `沙箱 playwright-cli 的浏览器 ${cliAbsent.join(' / ')}`, cmd: `node "${chosen.entry}" install-browser chromium` });
    } else out(`[PASS] 沙箱 playwright-cli 的浏览器 ${chosen.core.chromium.join(' / ')}`);
  }

  if (missing.length > 0) {
    if (!args.install) {
      needConfirm(
        'install',
        `缺少: ${missing.map((m) => m.item).join('、')}。将执行:\n${missing.map((m) => `  ${m.cmd}`).join('\n')}\n` +
          `国内下载慢,可征得用户同意后加环境变量 ${MIRROR_HINT}\n` +
          'Linux 若启动浏览器报缺少系统库,需要有 root 的人执行 playwright install-deps chromium\n' +
          '请问用户是否同意安装,同意带 --install 重跑',
      );
    }
    for (const m of missing) {
      out(`[INFO] 安装 ${m.item}: ${m.cmd}`);
      if (m.action) {
        try {
          const files = await m.action();
          applyFontsConf();
          out(`[PASS] 已写入 ${files.join(', ')};fontconfig 配置 ${FONTS_CONF}`);
        } catch (e) {
          fail(`安装 ${m.item} 失败: ${e.message}`);
        }
        continue;
      }
      const r = spawnSync(m.cmd, { cwd: projectDir, shell: true, stdio: 'inherit' });
      if (r.status !== 0) fail(`安装 ${m.item} 失败,可在 skill 的 tmp/ 下写临时脚本处理,解决后记进 LESSONS.md`);
    }
    out('[PASS] 已安装');
  }

  if (args['base-url']) {
    const r = spawnSync(process.execPath, ['-e', `fetch(${JSON.stringify(args['base-url'])}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))`]);
    if (r.status !== 0) fail(`被测地址 ${args['base-url']} 访问不通: 本机先 pnpm dev,或换成已部署的环境地址`);
    out(`[PASS] 被测地址可访问 ${args['base-url']}`);
    // 只看首页不够: 后端没起来时前端照样 200,接口会打到别处(实测 7101 被另一个部署占着,登录全部失败)
    const healthUrl = `${args['base-url'].replace(/\/+$/, '')}/api/health`;
    const health = spawnSync(
      process.execPath,
      ['-e', `fetch(${JSON.stringify(healthUrl)}).then(r=>r.json()).then(j=>{console.log(JSON.stringify(j));process.exit(j.status==='ok'?0:1)},()=>process.exit(1))`],
      { encoding: 'utf8' },
    );
    if (health.status !== 0) fail('后端健康检查不通过(/api/health): 前端能打开但后端没起来或不是这个项目的后端,先查端口占用');
    out(`[PASS] 后端健康 ${health.stdout.trim()}`);
  }
};

const start = () => {
  const projectDir = path.resolve(required('project-dir'));
  const baseUrl = required('base-url').replace(/\/+$/, '');
  const name = required('name');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail('--name 只能用小写字母、数字、连字符(用作目录名与回归脚本名)');
  const plan = readJson(path.resolve(required('plan')));
  if (typeof plan.intent !== 'string' || plan.intent === '') fail('plan.json 需要 intent(用户原话描述的测试意图)');
  if (!Array.isArray(plan.scenarios) || plan.scenarios.length === 0) fail('plan.json 需要 scenarios 数组');
  for (const s of plan.scenarios) {
    if (!s.id || !s.title || !Array.isArray(s.expect) || s.expect.length === 0) fail('每个场景需要 id、title、expect(期望数组)');
  }
  if (new Set(plan.scenarios.map((s) => s.id)).size !== plan.scenarios.length) fail('场景 id 重复');
  loadProjectEnv(projectDir);

  const runId = `${stamp()}-${name}`;
  const runDir = path.join(projectDir, 'e2e', '.runs', runId);
  fs.mkdirSync(path.join(runDir, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'snapshots'), { recursive: true });
  writeJson(path.join(runDir, 'plan.json'), plan);
  const { chosen } = resolveCli(projectDir, { quiet: true });
  const cli = chosen.entry;
  const meta = {
    runId,
    name,
    session: runId,
    projectDir,
    baseUrl,
    startedAt: now(),
    operator: git(projectDir, 'config user.name') || process.env.USERNAME || process.env.USER || '',
    pwcliVersion: spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).stdout.trim(),
    cli: { source: chosen.source, entry: chosen.entry, version: chosen.version, core: chosen.core.version },
    platform: `${process.platform}-${process.arch}`,
    git: {
      commit: git(projectDir, 'rev-parse HEAD'),
      shortCommit: git(projectDir, 'rev-parse --short HEAD'),
      branch: git(projectDir, 'rev-parse --abbrev-ref HEAD'),
      subject: git(projectDir, 'log -1 --pretty=%s'),
      dirty: git(projectDir, 'status --porcelain') !== '',
    },
  };
  writeJson(path.join(runDir, 'meta.json'), meta);
  writeJson(path.join(runDir, 'state.json'), { seq: 0, prevConsole: [], prevRequests: [] });

  // 明确用锁定版本的 chromium: 不指定时 pwcli 优先用系统 Chrome,本机与沙箱行为会不一样
  const opened = pw(runDir, meta.session, ['open', baseUrl, '--browser=chromium', ...(args.headed ? ['--headed'] : [])]);
  if (opened.code !== 0 || parseAction(opened.out).error) fail(`打开浏览器失败:\n${opened.out.trim()}`);
  pw(runDir, meta.session, ['tracing-start']);
  out(`[PASS] 已打开 ${baseUrl}(会话 ${meta.session},trace 录制中)`);
  out(`RUN_DIR=${runDir}`);
};

const act = () => {
  const run = openRun();
  const scenario = scenarioOf(run.plan);
  if (args.rest.length === 0) fail('用法: act --run R --scenario S -- <pwcli 参数>');
  const seq = run.state.seq + 1;
  const { real, used } = resolveSecrets(args.rest);
  const r = pw(run.runDir, run.meta.session, real);
  const parsed = parseAction(r.out);
  const error = r.code !== 0 || parsed.error ? maskText(parsed.error ?? r.out.trim().split('\n').slice(-6).join('\n'), used) : null;
  const evidence = capture(run, seq, used);
  const record = {
    run: run.meta.runId,
    seq,
    ts: now(),
    scenario,
    kind: 'act',
    why: args.why ?? null,
    command: maskText(args.rest.join(' '), used),
    code: parsed.code ? maskCode(parsed.code, used) : null,
    replay: !NON_REPLAY.has(args.rest[0]),
    result: error ? 'error' : 'ok',
    error,
    ...evidence,
  };
  appendStep(run.runDir, record);
  run.saveState({ ...run.state, seq });

  out(`${error ? '[FAIL]' : '[PASS]'} #${seq} ${record.command}`);
  if (record.code) out(record.code.replace(/^/gm, '  '));
  if (error) out(error.replace(/^/gm, '  '));
  out(`  页面 ${evidence.url ?? '?'}(${evidence.title ?? ''})`);
  out(`  快照 ${evidence.snapshot ? path.join(run.runDir, evidence.snapshot) : '无'}  截图 ${evidence.screenshot ?? '无'}`);
  for (const e of evidence.newConsoleErrors) out(`  [WARN] 控制台 ${e}`);
  for (const e of evidence.newFailedRequests) out(`  [WARN] 请求 ${e}`);
  if (error) process.exit(1);
};

const check = () => {
  const run = openRun();
  const scenario = scenarioOf(run.plan);
  const result = required('result');
  if (!['pass', 'fail'].includes(result)) fail('--result 只能是 pass 或 fail');
  const seq = run.state.seq + 1;
  const evidence = capture(run, seq, []);
  appendStep(run.runDir, {
    run: run.meta.runId,
    seq,
    ts: now(),
    scenario,
    kind: 'check',
    expect: required('expect'),
    actual: required('actual'),
    assert: args.assert ?? null,
    result,
    ...evidence,
  });
  run.saveState({ ...run.state, seq });
  out(`${result === 'pass' ? '[PASS]' : '[FAIL]'} #${seq} 检查: ${args.expect}`);
};

/** 由记录生成回归脚本草稿: 一个会话串行跑完所有场景,与探索时一致(登录态等在场景间延续)。 */
const buildSpec = (meta, plan, steps) => {
  const base = meta.baseUrl;
  const relative = (code) => code.split(`'${base}/`).join("'/").split(`'${base}'`).join("'/'");
  const body = plan.scenarios
    .map((sc) => {
      const lines = steps
        .filter((s) => s.scenario === sc.id)
        .flatMap((s) => {
          if (s.kind === 'act') return s.result === 'ok' && s.replay && s.code ? [relative(s.code)] : [];
          return [`// 检查: ${s.expect}`, s.assert ?? `// TODO 断言(探索时判定 ${s.result}): ${s.actual}`];
        });
      return `  test(${JSON.stringify(`${sc.id} ${sc.title}`)}, async () => {\n${lines.map((l) => l.replace(/^/gm, '    ')).join('\n')}\n  });`;
    })
    .join('\n\n');
  const usesExpect = steps.some((s) => s.kind === 'check' && s.assert?.includes('expect('));
  return `import { ${usesExpect ? 'expect, ' : ''}test, type Page } from '@playwright/test';

/**
 * 由 e2e-project 运行 ${meta.runId} 生成(版本 ${meta.git.shortCommit})。
 * 用户意图: ${plan.intent.replace(/\*\//g, '* /')}
 */
test.describe.serial(${JSON.stringify(meta.name)}, () => {
  let page: Page;

  test.beforeAll(async ({ browser }, testInfo) => {
    const { baseURL } = testInfo.project.use;
    page = await browser.newPage(baseURL === undefined ? {} : { baseURL });
  });

  test.afterAll(async () => {
    await page?.close();
  });

${body}
});
`;
};

const finish = () => {
  const run = openRun();
  pw(run.runDir, run.meta.session, ['tracing-stop']);
  pw(run.runDir, run.meta.session, ['close']);
  const meta = { ...run.meta, finishedAt: now() };
  writeJson(path.join(run.runDir, 'meta.json'), meta);
  const steps = readSteps(run.runDir);
  fs.writeFileSync(path.join(run.runDir, 'regression.spec.ts'), buildSpec(meta, run.plan, steps));
  const report = buildReport(run.runDir);
  const sum = summarize(steps);
  out(`[PASS] 已结束: ${sum.actions} 个操作(${sum.actionErrors} 个出错),检查 ${sum.checksPassed} 通过 / ${sum.checksFailed} 失败,控制台错误 ${sum.consoleErrors},失败请求 ${sum.failedRequests}`);
  out(`REPORT=${report}`);
  out(`SPEC_DRAFT=${path.join(run.runDir, 'regression.spec.ts')}`);
};

const regress = () => {
  const run = openRun();
  const spec = required('spec').replace(/\\/g, '/');
  const specAbs = path.resolve(run.meta.projectDir, spec);
  if (!fs.existsSync(specAbs)) fail(`回归脚本不存在: ${specAbs}`);
  const e2eDir = path.join(run.meta.projectDir, 'e2e');
  const rel = path.relative(e2eDir, specAbs).replace(/\\/g, '/');
  const r = spawnSync(`pnpm exec playwright test ${rel}`, {
    cwd: e2eDir,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, E2E_BASE_URL: run.meta.baseUrl },
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const passed = r.status === 0;
  writeJson(path.join(run.runDir, 'regression.json'), {
    spec,
    passed,
    at: now(),
    outputTail: output.trim().split('\n').slice(-30).join('\n'),
  });
  buildReport(run.runDir);
  out(output.trim().split('\n').slice(-30).join('\n'));
  out(`${passed ? '[PASS]' : '[FAIL]'} 回归脚本 ${spec}`);
  if (!passed) process.exit(1);
};

const verdict = () => {
  const run = openRun();
  const result = required('result');
  if (!['pass', 'fail'].includes(result)) fail('--result 只能是 pass 或 fail');
  if (!run.meta.finishedAt) fail('还没有 finish,先结束本次运行并把报告给用户看');
  const record = { result, note: args.note ?? '', by: run.meta.operator, at: now() };
  writeJson(path.join(run.runDir, 'verdict.json'), record);
  buildReport(run.runDir);

  const archiveRoot = path.join(run.meta.projectDir, 'e2e', 'archive');
  const target = path.join(archiveRoot, run.meta.runId);
  fs.cpSync(run.runDir, target, { recursive: true, filter: (src) => !ARCHIVE_SKIP.has(path.basename(src)) });
  // 归档要入库: 去掉本机绝对路径
  const { projectDir: _local, ...archivedMeta } = run.meta;
  writeJson(path.join(target, 'meta.json'), archivedMeta);
  const steps = readSteps(run.runDir);
  const sum = summarize(steps);
  const regressionFile = path.join(run.runDir, 'regression.json');
  const regression = fs.existsSync(regressionFile) ? readJson(regressionFile) : null;
  fs.appendFileSync(
    path.join(archiveRoot, 'index.jsonl'),
    `${JSON.stringify({
      runId: run.meta.runId,
      name: run.meta.name,
      intent: run.plan.intent,
      baseUrl: run.meta.baseUrl,
      commit: run.meta.git.shortCommit,
      branch: run.meta.git.branch,
      verdict: result,
      note: record.note,
      by: record.by,
      at: record.at,
      checksPassed: sum.checksPassed,
      checksFailed: sum.checksFailed,
      spec: regression?.spec ?? null,
      specPassed: regression?.passed ?? null,
    })}\n`,
  );
  out(`[PASS] 用户验收 ${result === 'pass' ? '通过' : '不通过'},已归档到 ${target}`);
  out(`REPORT=${path.join(target, 'report.html')}`);
};

const list = () => {
  const index = path.join(path.resolve(args['project-dir'] ?? '.'), 'e2e', 'archive', 'index.jsonl');
  if (!fs.existsSync(index)) return out('(还没有归档记录)');
  for (const line of fs.readFileSync(index, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    out(`${r.verdict === 'pass' ? '[PASS]' : '[FAIL]'} ${r.runId}  ${r.commit}(${r.branch})  检查 ${r.checksPassed}/${r.checksPassed + r.checksFailed}  ${r.spec ?? '无回归脚本'}  ${r.note}`);
  }
};

const COMMANDS = { doctor, start, act, check, finish, regress, verdict, list };
const command = COMMANDS[args._[0]];
if (command === undefined) fail(`未知命令 ${args._[0] ?? ''},可用: ${Object.keys(COMMANDS).join(' / ')}`);
await command();
