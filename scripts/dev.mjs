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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ports, apiPrefix } from './ports.mjs';
import { accessUrls, formatUrls } from './net.mjs';

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

ensurePostgres();

// 地址列表:
//  - 一律带上 contextPath —— 打印一个"看着对但点进去 404"的地址比不打印更费时间
//  - 前后端都列出所有网卡地址 —— 想用手机/同事电脑访问的人不必自己去 ipconfig 里翻 IP
//  - 前后端共用 HOST 变量,所以两边的地址列表口径一致:
//    绑全部网卡就都列局域网 IP,`HOST=127.0.0.1` 就都只列那一个,不会出现
//    "后端列了内网地址、前端只列 localhost"这种让人以为前端挂了的错位
process.stdout.write(
  [
    '',
    ...formatUrls('前端', accessUrls(ports.web, process.env.HOST, ports.contextBase)),
    ...formatUrls('后端', accessUrls(ports.server, process.env.HOST, `${apiPrefix}/`)),
    ...(ports.contextPrefix === ''
      ? []
      : ['', `  上下文根  ${ports.contextPrefix}   (改 ports.json 的 contextPath)`]),
    '',
    '  Ctrl+C 停止(会杀掉整棵进程树,不留孤儿)',
    '',
  ].join('\n'),
);

start('server', ['--filter', '@app/server', 'dev']);
start('web', ['--filter', '@app/web', 'dev']);
