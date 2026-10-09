/**
 * playwright-cli 调用与输出解析。
 *
 * 直接用 node 跑 cli 的 js 入口,不走 playwright-cli.cmd: Windows 上 spawn .cmd 必须开 shell,中文与空格参数会被拆坏。
 * 所有调用的 cwd 都是本次运行目录,pwcli 的快照、控制台日志、trace 都落在 <run>/.playwright-cli/ 下。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * [版本唯一来源] playwright-cli 与 @playwright/test 都是项目 e2e/package.json 的开发依赖,
 * 锁在同一个 playwright-core 版本上(lockfile 入库)。skill 只用项目里的这一份,不用全局安装:
 *   - 项目与 skill、本机与沙箱用的必然是同一版本
 *   - 两者共用一个内核,只需要一套浏览器;内核不同时浏览器版本不同(实测 1247 vs 1248),
 *     混用会出现"导航和快照正常、点击输入静默失效"
 *   - 沙箱非 root 也不需要全局安装
 */
const pkgDir = (projectDir, name) => path.join(projectDir, 'e2e', 'node_modules', ...name.split('/'));

let cachedCli;

/** 项目里 pwcli 的 js 入口;没装(没 pnpm install)返回 null。结果缓存,后续 pw() 使用。 */
export const findCli = (projectDir) => {
  const entry = path.join(pkgDir(projectDir, '@playwright/cli'), 'playwright-cli.js');
  cachedCli = fs.existsSync(entry) ? entry : null;
  return cachedCli;
};

/** 某个包实际使用的 playwright-core: 版本号与所需的 chromium 浏览器目录名(如 chromium_headless_shell-1247)。 */
export const coreOf = (projectDir, name) => {
  const dir = pkgDir(projectDir, name);
  if (!fs.existsSync(dir)) return null;
  // pnpm 的依赖是软链,真实目录在 .pnpm/<包@版本>/node_modules/ 下,它的依赖与它同级。
  // @playwright/cli 直接依赖 playwright-core;@playwright/test 经由 playwright 再依赖 playwright-core
  const siblings = (real) => path.join(real, ...name.split('/').map(() => '..'));
  const viaSibling = (real, dep) => path.join(siblings(real), dep);
  const real = fs.realpathSync(dir);
  let coreDir = viaSibling(real, 'playwright-core');
  if (!fs.existsSync(path.join(coreDir, 'browsers.json')) && fs.existsSync(viaSibling(real, 'playwright'))) {
    coreDir = path.join(fs.realpathSync(viaSibling(real, 'playwright')), '..', 'playwright-core');
  }
  if (!fs.existsSync(path.join(coreDir, 'browsers.json'))) return null;
  const { version } = JSON.parse(fs.readFileSync(path.join(coreDir, 'package.json'), 'utf8'));
  const { browsers } = JSON.parse(fs.readFileSync(path.join(coreDir, 'browsers.json'), 'utf8'));
  const chromium = browsers
    .filter((b) => b.name === 'chromium' || b.name === 'chromium-headless-shell')
    .map((b) => `${b.name.replace(/-/g, '_')}-${b.revision}`);
  return { version, chromium };
};

/** 普通 npm 布局下一个 @playwright/cli 包目录对应的内核(依赖在包内 node_modules,或被提升到同级)。 */
const coreOfCliDir = (cliDir) => {
  for (const coreDir of [path.join(cliDir, 'node_modules', 'playwright-core'), path.join(cliDir, '..', '..', 'playwright-core')]) {
    if (!fs.existsSync(path.join(coreDir, 'browsers.json'))) continue;
    const { version } = JSON.parse(fs.readFileSync(path.join(coreDir, 'package.json'), 'utf8'));
    const { browsers } = JSON.parse(fs.readFileSync(path.join(coreDir, 'browsers.json'), 'utf8'));
    return {
      version,
      chromium: browsers
        .filter((b) => b.name === 'chromium' || b.name === 'chromium-headless-shell')
        .map((b) => `${b.name.replace(/-/g, '_')}-${b.revision}`),
    };
  }
  return null;
};

/**
 * 沙箱(或本机)全局装的 playwright-cli,以后沙箱镜像可能内置一份。
 * 依次找: PATH 上的 playwright-cli(Linux 下是指向包内 js 的软链)、npm 全局目录。
 * @returns {{entry:string, version:string, core:{version:string, chromium:string[]}|null}|null}
 */
export const findSandboxCli = () => {
  const candidates = [];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const bin = path.join(dir, 'playwright-cli');
    if (process.platform !== 'win32' && fs.existsSync(bin)) candidates.push(fs.realpathSync(bin));
  }
  const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout?.trim();
  if (npmRoot) candidates.push(path.join(npmRoot, '@playwright', 'cli', 'playwright-cli.js'));

  for (const entry of candidates) {
    const pkg = path.join(path.dirname(entry), 'package.json');
    if (!fs.existsSync(entry) || !fs.existsSync(pkg)) continue;
    const { name, version } = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    if (name !== '@playwright/cli') continue;
    return { entry, version, core: coreOfCliDir(path.dirname(entry)) };
  }
  return null;
};

/** 指定后续 pw() 使用的 cli 入口(用户选了沙箱内置版本时)。 */
export const useCli = (entry) => {
  cachedCli = entry;
};

/** 项目依赖里 @playwright/cli 的版本号。 */
export const projectCliVersion = (projectDir) =>
  JSON.parse(fs.readFileSync(path.join(pkgDir(projectDir, '@playwright/cli'), 'package.json'), 'utf8')).version;

/**
 * @param {string} cwd 运行目录
 * @param {string} session pwcli 会话名(= 运行号,互不干扰)
 * @param {string[]} args pwcli 参数
 * @returns {{code:number, out:string}}
 */
export const pw = (cwd, session, args) => {
  const cli = cachedCli;
  if (!cli) throw new Error('没有找到项目里的 playwright-cli,先执行 doctor');
  const r = spawnSync(process.execPath, [cli, `-s=${session}`, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { code: r.status ?? 1, out };
};

/** 把 "### 标题\n内容" 形式的输出拆成 { 标题: 内容 }。 */
export const sections = (out) => {
  const result = {};
  const parts = out.split(/^### (.+)$/m);
  for (let i = 1; i < parts.length; i += 2) result[parts[i].trim()] = parts[i + 1].trim();
  return result;
};

/** 解析一次动作的输出: 等价代码、页面地址与标题、快照文件、错误。 */
export const parseAction = (out) => {
  const s = sections(out);
  const code = (s['Ran Playwright code'] ?? '').replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
  const page = s['Page'] ?? '';
  const snapshot = /\[Snapshot\]\(([^)]+)\)/.exec(s['Snapshot'] ?? '')?.[1];
  const error = s['Error'] ?? (/^Error: .+/m.exec(out)?.[0] ?? null);
  return {
    code,
    url: /- Page URL: (.+)/.exec(page)?.[1]?.trim() ?? null,
    title: /- Page Title: (.+)/.exec(page)?.[1]?.trim() ?? null,
    snapshot: snapshot ? snapshot.replace(/\\/g, '/') : null,
    error: error ? error.split('\n').slice(0, 6).join('\n') : null,
  };
};

/** 当前页的控制台错误,每条一行。 */
export const consoleErrors = (cwd, session) =>
  pw(cwd, session, ['--raw', 'console', 'error'])
    .out.split('\n')
    .filter((l) => l.startsWith('[ERROR]'));

/** 当前页失败的请求(状态码 >= 400 或请求失败),每条一行,去掉序号。 */
export const failedRequests = (cwd, session) =>
  pw(cwd, session, ['--raw', 'requests'])
    .out.split('\n')
    .map((l) => l.replace(/^\d+\.\s*/, '').trim())
    .filter((l) => /=> \[(?:[45]\d\d|FAILED)/i.test(l));
