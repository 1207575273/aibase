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
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 端口与 dev.mjs、vite、后端 config 同源 —— 都来自 .env
import { ports } from './ports.mjs';
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

/** /proc/net/tcp 里 LISTEN 状态的编码 */
const TCP_LISTEN = '0A';

/**
 * Linux 侧找 pid —— 直接读 /proc,不依赖任何外部命令。
 *
 * [为什么] 沙箱 / 精简容器镜像里 lsof、ss、netstat、fuser 可能一个都没有,用户又是非 root、无 sudo,
 * 装不了 iproute2。/proc 是 ss 自己的数据来源,任何 Linux 都有:
 *   1. /proc/net/tcp、tcp6 里找本地端口 = port 且状态为 LISTEN 的 socket,取 inode
 *   2. 遍历 /proc/<pid>/fd/*,链接目标为 socket:[inode] 的进程就是监听者
 *
 * [非 root] 只能读自己进程的 fd。端口在监听却找不到属主(别的用户的进程)时明确报错 ——
 * 静默返回空数组会让人以为端口是干净的,然后对着 EADDRINUSE 一脸茫然。
 */
const findPidsLinux = (port) => {
  const inodes = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // 内核没开 IPv6 时 tcp6 不存在
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== TCP_LISTEN) continue;
      if (parseInt(cols[1].split(':')[1], 16) === port) inodes.add(cols[9]);
    }
  }
  if (inodes.size === 0) return [];

  const pids = new Set();
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    let fds;
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // 别的用户的进程,或已经退出
    }
    for (const fd of fds) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m && inodes.has(m[1])) pids.add(pid);
      } catch {
        // fd 在遍历过程中关闭了
      }
    }
  }
  if (pids.size === 0) {
    process.stderr.write(`[FAIL] 端口 ${port} 正在被监听,但找不到属主进程(可能属于其他用户)。换一个端口段,或请有权限的人处理\n`);
    process.exit(1);
  }
  return [...pids];
};

/**
 * macOS 等非 Linux 的 Unix 侧找 pid —— lsof 与 ss 都试(没有 /proc)。
 *
 * [坑] execFileSync 在"命令不存在"时抛的异常与"没匹配到"长得一样,
 * 必须看退出码区分,两个都没有时明确报错,不能静默当作端口空闲。
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
  if (isLinux) return findPidsLinux(port);
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
      // 用 process.kill 而不是外部 kill 命令: 精简镜像里 /bin/kill(procps)不一定有
      process.kill(Number(pid), force ? 'SIGKILL' : 'SIGTERM');
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
