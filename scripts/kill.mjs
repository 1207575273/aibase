/**
 * 端口清理 —— 杀掉占用本项目端口的进程。
 *
 * 干什么: 读 ports.json,找出占用这些端口的进程,连子进程一起杀掉。
 * 什么时候用: 上次开发进程没退干净、报 EADDRINUSE 起不来时,`pnpm kill` 一下。
 *
 * 为什么需要它: 即使 dev.mjs 已经处理了正常的 Ctrl+C,还是有别的情况会留下孤儿 ——
 *   编辑器直接关掉终端、进程被强杀、调试器挂起。这是兜底工具。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ports = JSON.parse(readFileSync(resolve(ROOT, 'ports.json'), 'utf8'));
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
const findPids = (port) => {
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

const kill = (pid) => {
  try {
    if (isWindows) {
      // /T 连子进程一起杀 —— pnpm/tsx 会 fork,只杀父进程解决不了问题
      execFileSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
    } else {
      execFileSync('kill', ['-9', pid], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
};

let killed = 0;
for (const [name, port] of Object.entries(ports)) {
  const pids = findPids(port);
  if (pids.length === 0) {
    process.stdout.write(`[SKIP] ${name} :${port} 未被占用\n`);
    continue;
  }
  for (const pid of pids) {
    const ok = kill(pid);
    process.stdout.write(`${ok ? '[PASS]' : '[FAIL]'} ${name} :${port} -> pid ${pid}\n`);
    if (ok) killed += 1;
  }
}

process.stdout.write(`\n共清理 ${killed} 个进程\n`);
