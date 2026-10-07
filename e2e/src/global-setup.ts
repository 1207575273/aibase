/**
 * e2e 全局前置 —— 建一个独立 schema,起一个真实的服务进程。
 *
 * 干什么: 建 schema -> 跑迁移 -> 灌种子 -> spawn 服务进程 -> 等它就绪。
 *         全部用例跑完后杀进程、删 schema。
 *
 * 为什么是 schema 而不是 database: 沙箱里所有项目共用一个 PG 实例、只有自己 schema 的权限,
 *   没有 CREATEDB。e2e 走的正是上线路径: 同一个 DATABASE_URL + 不同的 DATABASE_SCHEMA。
 *
 * 为什么要起真进程而不是像后端单测那样 app.request():
 *   app.request() 走的是 Hono 的内存 fetch,**绕过了整个 Node HTTP 层**。
 *   它验不到: 进程能不能起来、配置加载对不对、端口绑定、
 *   真实的响应头往返、请求体大小限制在网络层的行为、优雅关闭。
 *   这些恰恰是"本地全绿、部署就炸"的高发区。
 *
 * [不经过 nginx] e2e 直连后端进程,验的是 API 本身的行为。
 *   nginx 那一层(静态托管、反代、压缩)由容器冒烟验证,
 *   放进 e2e 会逼得每次跑测试都要起一整套 compose,反馈循环太慢。
 *
 * [Windows] 用 detached + taskkill /T 杀整棵进程树 —— tsx 会 fork 子进程,
 *   直接 kill 父进程会留下孤儿占住端口,下次跑 e2e 就起不来。
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
// @ts-expect-error 纯 JS 模块,无类型声明;被 vite、开发脚本与本文件共用
import { ports, contextPrefix as ctxPrefix } from '../../scripts/ports.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');

// e2e 跑在自己的进程里,不经过 src/config,所以要显式加载 .env 拿 DATABASE_URL
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // CI 用真实环境变量
}

/**
 * 端口与上下文根都来自 `scripts/ports.mjs`(它读 `.env`),与后端、vite 同源。
 *
 * [坑] E2E_PORT 必须从开发端口**算出来**,不能写死。
 * 之前这里硬编码了一个"与开发端口错开"的值,而项目端口一改就正好撞号 ——
 * 注释描述的防护完全失效,且没有任何东西会提醒你。
 * 用 `开发端口 + 1000` 派生,改 .env 时自动跟着走。
 */
const E2E_PORT: number = (ports as { server: number }).server + 1000;
const contextPrefix: string = ctxPrefix;

export const BASE_URL = `http://127.0.0.1:${E2E_PORT}${contextPrefix}/api`;

/** 固定的种子密码,用例直接用它登录。 */
export const E2E_ADMIN = { username: 'admin', password: 'e2e-admin-pass-123' };

/** e2e 专用 schema 名带 pid —— 两个并发的 e2e 进程不会互相踩。 */
const E2E_SCHEMA = `tmp_e2e_${process.pid}`;

let child: ChildProcess | undefined;
let databaseUrl: string | undefined;

const isWindows = process.platform === 'win32';

/** 在 e2e 用的库里执行一条语句。建 schema / 删 schema 都走这里。 */
const runSql = async (url: string, sql: string): Promise<void> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
};

/** 轮询 /health 直到服务就绪。 */
const waitForReady = async (timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'never attempted';

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
      lastError = `health 返回 ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内未就绪,最后一次错误: ${lastError}`);
};

export const setup = async (): Promise<void> => {
  // 与单测一样连开发库,自己建一个独立的 e2e schema(见 server/tests/helpers/global-setup.ts)
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL 未设置。跑 e2e 前先起开发数据库:\n' +
        '  docker compose -f deploy/docker-compose.dev.yml up -d --wait',
    );
  }
  databaseUrl = url;

  // 上一次被 Ctrl+C 掐断会留下残留 schema,先删再建
  await runSql(url, `DROP SCHEMA IF EXISTS "${E2E_SCHEMA}" CASCADE`);
  await runSql(url, `CREATE SCHEMA "${E2E_SCHEMA}"`);

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(E2E_PORT),
    HOST: '127.0.0.1',
    DATABASE_URL: url,
    DATABASE_SCHEMA: E2E_SCHEMA,
    LOG_LEVEL: 'error',
    SEED_ADMIN_PASSWORD: E2E_ADMIN.password,
  };

  const run = (args: string[]): void => {
    execFileSync('pnpm', args, { cwd: REPO_ROOT, env, stdio: 'inherit', shell: isWindows });
  };

  // 真跑迁移(不是 db push)—— 顺带把 schema 与 migration 的漂移暴露出来
  run(['db', 'deploy']);
  run(['db', 'seed']);

  child = spawn('pnpm', ['--filter', '@app/server', 'dev'], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
    shell: isWindows,
    detached: !isWindows,
  });

  child.on('error', (e) => {
    process.stderr.write(`[FAIL] 服务进程启动失败: ${e.message}\n`);
  });

  await waitForReady(60_000);
};

export const teardown = async (): Promise<void> => {
  if (child?.pid !== undefined) {
    if (isWindows) {
      // /T 杀整棵树 —— pnpm -> tsx -> node 是三层,只杀顶层会留孤儿占着端口
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // 进程可能已经退出,忽略
      }
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // 同上
      }
    }
  }

  if (databaseUrl === undefined) return;

  // 给进程一点时间释放连接;DROP SCHEMA 不要求无连接,但残留事务持锁会让它等待
  await new Promise((r) => setTimeout(r, 500));
  await runSql(databaseUrl, `DROP SCHEMA IF EXISTS "${E2E_SCHEMA}" CASCADE`);
};
