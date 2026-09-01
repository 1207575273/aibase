/**
 * 端口清理 —— 杀掉占用本项目端口的进程。
 *
 * 干什么: 从 ports.mjs(它读 .env)取端口,找出占用的进程,连子进程一起杀掉。
 * 什么时候用: 上次开发进程没退干净、报 EADDRINUSE 起不来时,`pnpm kill` 一下。
 *   `pnpm dev` 启动前也会自动调 freePort(),所以正常情况不需要手动跑。
 *
 * 为什么需要它: 即使 dev.mjs 已经处理了正常的 Ctrl+C,还是有别的情况会留下孤儿 ——
 *   编辑器直接关掉终端、进程被强杀、调试器挂起。这是兜底工具。
 *
 * [双重身份] 本文件既是可执行脚本(`pnpm kill`),也导出 findPids / freePort 给
 *   dev.mjs 复用。所以顶层的执行逻辑包在 isMain 判断里 —— 不这么做的话,
 *   dev.mjs 一 import 就会把端口全清一遍,而那时它自己都还没启动。
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 端口与 dev.mjs、vite、后端 config 同源 —— 都来自 .env
import { ports } from './ports.mjs';
const isWindows = process.platform === 'win32';

/**
 * Unix 侧找 pid —— lsof 与 ss 都试。
 *
 * [坑] 不能只用 lsof。精简的服务器镜像(debian-slim、alpine、多数容器基础镜像)
 * 默认不装 lsof,而 execFileSync 在"命令不存在"时抛的异常与"没匹配到"
 * 长得一样。只用 lsof 的话,端口明明被占着,`pnpm kill` 却报告没找到进程 ——
 * 失败得完全静默,人会以为端口是干净的,然后对着 EADDRINUSE 一脸茫然。
 *
 * ss 来自 iproute2,现代 Linux 发行版基本都自带,比 lsof 普及得多。
 * 两个都没有时明确抛出,由调用方区分"工具缺失"和"端口空闲"。
 */
const findPidsUnix = (port) => {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((pid) => pid.trim() !== '');
  } catch (err) {
    // 退出码 1 = lsof 正常运行但没匹配到,这时端口确实是空闲的
    if (err.status === 1) return [];
  }

  // 走到这里说明 lsof 不可用(ENOENT 或其他异常),换 ss
  // 输出形如: users:(("node",pid=1234,fd=20))
  try {
    const out = execFileSync('ss', ['-lptnH', `sport = :${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set([...out.matchAll(/pid=(\d+)/g)].map((m) => m[1]))];
  } catch (err) {
    if (err.status === 1) return [];
    // 两个工具都没有 —— 必须说出来。静默返回空数组会让人以为端口是干净的。
    process.stderr.write('[FAIL] 找不到 lsof 或 ss,无法查端口占用。装一个:apt install iproute2 / apk add iproute2\n');
    process.exit(1);
  }
};

/** 找出监听指定端口的进程 pid。 */
export const findPids = (port) => {
  if (!isWindows) return findPidsUnix(port);
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    return [
      ...new Set(
        out
          .split('\n')
          .filter((line) => line.includes(`:${port} `) && line.includes('LISTENING'))
          .map((line) => line.trim().split(/\s+/).pop())
          .filter((pid) => pid !== undefined && pid !== '0'),
      ),
    ];
  } catch {
    // netstat 找不到匹配时会非零退出,等价于"没有进程占用"
    return [];
  }
};

/**
 * 杀掉一个进程。
 *
 * force=false 先发 SIGTERM 给它自己收尾的机会(后端的优雅关闭会跑,
 * 在途请求处理完、日志冲刷落盘);force=true 才是 SIGKILL 硬杀。
 *
 * [为什么不一上来就 -9] 见过的做法是 `lsof -ti :PORT | xargs kill -9` 一把梭 ——
 * 快,但等于每次重启开发环境都模拟一次断电:在途请求被掐断,pino 缓冲区里的
 * 日志直接丢。开发时看不出问题,养成的习惯带到生产脚本里就会出事。
 */
export const killPid = (pid, { force = true } = {}) => {
  try {
    if (isWindows) {
      // /T 连子进程一起杀 —— pnpm/tsx 会 fork,只杀父进程解决不了问题。
      // Windows 没有 SIGTERM 的等价物,taskkill 不带 /F 时发的是 WM_CLOSE,
      // 对控制台程序基本等于没发,所以这里非 force 也只能尽力而为。
      execFileSync('taskkill', ['/pid', pid, '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore' });
    } else {
      execFileSync('kill', [force ? '-9' : '-15', pid], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 释放一个端口:先温和请求退出,不行再硬杀。
 *
 * @returns 清理掉的进程数(0 表示端口本来就是空闲的)
 */
export const freePort = async (name, port, { quiet = false } = {}) => {
  const pids = findPids(port);
  if (pids.length === 0) {
    if (!quiet) process.stdout.write(`[SKIP] ${name} :${port} 未被占用\n`);
    return 0;
  }

  // 第一轮:SIGTERM,给优雅关闭一秒钟
  for (const pid of pids) killPid(pid, { force: false });
  await sleep(1000);

  // 第二轮:还活着的才硬杀
  let killed = 0;
  for (const pid of findPids(port)) {
    const ok = killPid(pid, { force: true });
    if (!quiet) process.stdout.write(`${ok ? '[PASS]' : '[FAIL]'} ${name} :${port} -> pid ${pid}(强制)\n`);
    if (ok) killed += 1;
  }

  const gracefully = pids.length - killed;
  if (gracefully > 0 && !quiet) {
    process.stdout.write(`[PASS] ${name} :${port} -> ${gracefully} 个进程已优雅退出\n`);
  }
  return pids.length;
};

/**
 * 本项目要清理的端口。
 *
 * [注意] 只遍历真正的端口。ports 对象里还有 contextPrefix / contextBase 两个字符串,
 * 一起遍历会打出 "contextBase :/ 未被占用" 这种没有意义的行。
 */
export const DEV_PORTS = [
  ['server', ports.server],
  ['web', ports.web],
];

// ── 作为脚本执行时才清理(被 import 时不执行)──────────────────
const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  let total = 0;
  for (const [name, port] of DEV_PORTS) {
    total += await freePort(name, port);
  }
  process.stdout.write(`\n共清理 ${total} 个进程\n`);
}
