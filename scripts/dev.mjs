/**
 * 开发启动器 —— 一条命令起后端 + 前端。
 *
 * 干什么: 并行 spawn 两个子进程,统一给输出加前缀,Ctrl+C 时**杀掉整棵进程树**。
 *
 * 解决什么问题:
 *   Windows 下 `pnpm -> tsx watch -> node` 是三层进程,信号传不到孙子进程。
 *   直接用 `concurrently` 或 shell 的 `&`,Ctrl+C 之后会留下孤儿进程占着端口,
 *   下次启动报 EADDRINUSE,而且要手工去任务管理器里找。
 *   这里自己持有 PID 并用 taskkill /T 杀整棵树,彻底解决。
 *
 * 为什么不用第三方并行工具: 这段逻辑只有 60 行,且核心价值正是那个平台相关的
 *   杀进程树处理 —— 通用工具恰恰做不好这一点。
 */

import { spawn, execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ports, apiPrefix } from './ports.mjs';
import { accessUrls, formatUrls } from './net.mjs';
import { DEV_PORTS, freePort } from './kill.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

const COLORS = { server: '\x1b[36m', web: '\x1b[35m', reset: '\x1b[0m' };

const children = [];

/** 起一个子进程,给它的每行输出加上带颜色的名字前缀。 */
const start = (name, args) => {
  const child = spawn('pnpm', args, {
    cwd: ROOT,
    shell: isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `${COLORS[name]}[${name}]${COLORS.reset} `;
  const pipe = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // 最后一段可能是不完整的行,留到下次
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(`${prefix}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    process.stdout.write(`${prefix}退出,code=${code}\n`);
    // 一个挂了就把另一个也停掉 —— 只剩半套服务时继续跑只会让人困惑
    shutdown();
  });

  children.push(child);
  return child;
};

let shuttingDown = false;

const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    if (isWindows) {
      // /T 杀整棵树。没有它,tsx 和它 fork 的 node 会变成孤儿继续占端口。
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // 进程可能已退出
      }
    } else {
      try {
        child.kill('SIGTERM');
      } catch {
        // 同上
      }
    }
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * 确保开发用的 PostgreSQL 在跑。
 *
 * 为什么要自动做这件事: 换成 PG 之后,"clone 下来直接 pnpm dev"这条体验
 * 本来会退化成"先记得起数据库,不然一堆连接错误"。新人第一次跑就撞墙,
 * 而错误信息(ECONNREFUSED)离真正的原因隔着好几层。
 *
 * 检测用 `docker compose ps` 而不是探端口: 端口通不代表是**我们这个**库
 * (本机可能有别的 PG 占着,那种"连上了但表都不对"的症状最难查)。
 *
 * docker 不可用时**不阻塞启动** —— 有人可能连的是远程库或本机自装的 PG,
 * 这种情况下打一行提示就够了,不该替他做决定。
 */
const ensurePostgres = () => {
  const composeFile = resolve(ROOT, 'deploy/docker-compose.dev.yml');
  const compose = (args, opts = {}) =>
    execFileSync('docker', ['compose', '-f', composeFile, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      ...opts,
    });

  try {
    // --status running 只列真正在跑的;容器存在但已退出会返回空
    const running = compose(['ps', '--status', 'running', '--services'], { stdio: 'pipe' });
    if (running.includes('postgres')) return;
  } catch {
    process.stdout.write(
      '\n  [WARN] 无法调用 docker,跳过数据库自动启动。\n' +
        '         如果连的是远程库或本机自装的 PG,忽略这条即可。\n',
    );
    return;
  }

  process.stdout.write('\n  数据库未运行,正在启动 (deploy/docker-compose.dev.yml)...\n');
  try {
    // --wait 会等到 healthcheck 通过才返回,避免应用连上一个还没就绪的 PG
    compose(['up', '-d', '--wait'], { stdio: 'inherit' });
    process.stdout.write('  数据库已就绪\n');
  } catch {
    process.stderr.write(
      '\n  [FAIL] 数据库启动失败。手动排查:\n' +
        '         docker compose -f deploy/docker-compose.dev.yml up -d\n\n',
    );
    process.exit(1);
  }
};

/**
 * 探一个端口是否已经在监听。
 *
 * 用真实 TCP 连接而不是 sleep 几秒 —— 固定等待要么白等(机器快),
 * 要么等不够(机器慢、首次要编译),两头都不讨好。
 */
const canConnect = (port) =>
  new Promise((resolveCheck) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.destroy();
      resolveCheck(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });

/** 轮询直到端口就绪或超时。 */
const waitPort = async (port, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    if (await canConnect(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

/**
 * 启动前清空自己的端口 —— 让 `pnpm dev` 可以反复执行。
 *
 * 为什么需要: 编辑器直接关终端、进程被强杀、调试器挂起,都会留下占着端口的孤儿,
 * 下次启动报 EADDRINUSE。以前要手动 `pnpm kill` 一下,而人总是先撞上报错才想起来。
 *
 * freePort 是**先 SIGTERM 再 SIGKILL**的,不是一上来就 -9 ——
 * 让上一次的进程有机会冲刷日志、关掉数据库连接。
 */
const freeOwnPorts = async () => {
  const results = await Promise.all(
    DEV_PORTS.map(([name, port]) => freePort(name, port, { quiet: true })),
  );
  const total = results.reduce((a, b) => a + b, 0);
  if (total > 0) {
    process.stdout.write(`  清理了 ${total} 个占用端口的残留进程\n`);
  }
};

ensurePostgres();
await freeOwnPorts();

start('server', ['--filter', '@app/server', 'dev']);
start('web', ['--filter', '@app/web', 'dev']);

/*
 * 等两个服务都真的在监听了,再打印地址。
 *
 * [为什么不 spawn 完就打印] 那样地址会在服务还没起来时就出现在终端上,
 * 而这个项目冷启动要好几秒(tsx 编译 + vite 预构建)。人看到地址就会去点,
 * 点到的是 ERR_CONNECTION_REFUSED,然后开始怀疑是不是配置错了 ——
 * 实际上只要再等两秒。首次启动(依赖要预构建)最容易撞上。
 *
 * 超时也照常打印地址: 服务可能只是慢,而不是挂了;把地址藏起来帮不上忙。
 */
process.stdout.write('\n  正在启动...\n');

const [serverUp, webUp] = await Promise.all([
  waitPort(ports.server, 60_000),
  waitPort(ports.web, 60_000),
]);

if (!shuttingDown) {
  const warn = [];
  if (!serverUp) warn.push(`  [WARN] 后端 60s 内未监听 :${ports.server},看上面的 [server] 日志`);
  if (!webUp) warn.push(`  [WARN] 前端 60s 内未监听 :${ports.web},看上面的 [web] 日志`);

  // 地址列表:
  //  - 一律带上 contextPath —— 打印一个"看着对但点进去 404"的地址比不打印更费时间
  //  - 前后端都列出所有网卡地址 —— 想用手机/同事电脑访问的人不必自己去 ipconfig 里翻 IP
  //  - 前后端共用 HOST 变量,所以两边的地址列表口径一致:
  //    绑全部网卡就都列局域网 IP,`HOST=127.0.0.1` 就都只列那一个,不会出现
  //    "后端列了内网地址、前端只列 localhost"这种让人以为前端挂了的错位
  process.stdout.write(
    [
      '',
      ...warn,
      ...(warn.length > 0 ? [''] : []),
      ...formatUrls('前端', accessUrls(ports.web, process.env.HOST, ports.contextBase)),
      ...formatUrls('后端', accessUrls(ports.server, process.env.HOST, `${apiPrefix}/`)),
      ...(ports.contextPrefix === ''
        ? []
        : ['', `  上下文根  ${ports.contextPrefix}   (改 .env 的 CONTEXT_PATH)`]),
      '',
      '  Ctrl+C 停止(会杀掉整棵进程树,不留孤儿)',
      '',
    ].join('\n'),
  );
}
