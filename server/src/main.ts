/**
 * 后端入口。
 *
 * 只做四件事: 建上下文 -> 装配模块 -> 建 app -> 监听。
 *
 * [约束] 这个文件不随业务增长 —— **加业务模块改的是 composition/modules.ts,不是这里**。
 * 它只在"多一种运行形态"(比如加个 WebSocket 挂载)时才会变长。
 * 超过约 150 行说明有运行时关注点该挪进 bootstrap/ 了。
 * (对照: 曾见过的一个项目的 main.ts 有 1173 行,因为 12 个域的装配全塞在里面。)
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerShutdown } from './bootstrap/shutdown.js';
import { config, REPO_ROOT } from './config/index.js';
import { accessUrls } from './infrastructure/system/access-urls.js';
import { createContext } from './composition/context.js';
import { describeConnection } from './infrastructure/persistence/postgres/prisma-client.js';
import { buildModules } from './composition/modules.js';
import { buildApp } from './interface/http/app.js';
import type { AppEnv } from './interface/http/env.js';
import { handleError, handleNotFound } from './interface/http/handle-error.js';

/** 版本号单一来源:从 package.json 读。不硬编码 —— 硬编码的版本号迟早是错的。 */
const readVersion = (): string => {
  try {
    const raw = readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

const bootstrap = async (): Promise<void> => {
  const startedAt = new Date();
  const ctx = await createContext();
  const logger = ctx.logger;

  const app = buildApp({
    ...(await buildModules(ctx)),
    version: readVersion(),
    startedAt,
  });


  /*
   * 挂载 —— 后端**只提供 API**,不托管任何静态资源。
   *
   * 生产形态是 nginx 作为唯一入口:静态文件由 nginx 直接发(顺带做 gzip 和缓存头),
   * /api 反代到这个进程。所以这里只有一条挂载。
   *
   * [为什么删掉了 SERVE_WEB] 以前后端能同时托管 web/dist 做单进程部署。
   * 留着它就是两种生产形态并存: 同一个 contextPath 在"后端托管"和"nginx 托管"
   * 下的路径改写规则不一样(Hono 的 route(prefix) 不改写 c.req.path,
   * 要靠 rewriteRequestPath 补;nginx 那边是 location + alias),
   * 两条路都得测、都得维护,而真正会用的只有一条。
   * 单进程部署的需求由 docker compose 满足 —— 那是四个容器,但仍然是一条命令。
   */
  const root = new Hono<AppEnv>();

  // API 一律挂 ${contextPath}/api。config.apiPrefix 与前端 axios 的 baseURL
  // 都从 .env 的 CONTEXT_PATH 推导,两边不会漂。
  root.route(config.apiPrefix, app);

  /*
   * [必须有] 外层也要挂统一的错误出口。
   *
   * Hono 的子 app 挂载有个反直觉的行为: `root.route(prefix, app)` 之后,
   * **未匹配到的请求由最外层的 notFound 处理,而不是子 app 的**。
   * 所以只在 buildApp 里挂 app.notFound 是不够的 —— 请求一个不存在的 API 路径,
   * 拿到的是 Hono 默认的纯文本 "404 Not Found",而不是统一的 JSON 错误形状。
   * 前端会拿这坨文本去 JSON.parse,报出来的错和真实原因毫无关系。
   *
   * [为什么以前没暴露] 以前后端还托管前端时,SPA fallback 的 `web.get('*')`
   * 接住了所有未匹配请求,这个缺口被盖住了。删掉静态托管后它才露出来。
   *
   * [为什么测试没抓到] app.test.ts 测的是 buildApp 返回的**内层 app**,
   * 不经过这里的 root 组装 —— 内层测试全绿,生产行为却不同。
   * main.ts 的组装本身没有测试覆盖,这是已知的盲区(见 CLAUDE.md 踩坑第 20 条)。
   */
  root.notFound(handleNotFound);
  root.onError(handleError);

  const server = serve({ fetch: root.fetch, port: config.port, hostname: config.host }, (info) => {
    logger.info('服务已启动', {
      // 绑 0.0.0.0 时列出全部网卡地址,而不是打印一个没法直接点的 "0.0.0.0:7001" ——
      // 部署到服务器或容器里时,这几行就是运维确认"到底该访问哪个地址"的依据
      urls: accessUrls(info.port, config.host, config.contextBase),
      health: `${config.apiPrefix}/health`,
      env: config.nodeEnv,
      // 只打 host:port/dbname —— 连接串里有密码,整条进日志就是凭证泄漏
      db: describeConnection(config.databaseUrl),
    });
  });

  registerShutdown({
    logger,
    closeServer: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err !== undefined && err !== null ? rejectClose(err) : resolveClose()));
      }),
    cleanup: async () => {
      await ctx.prisma.$disconnect();
      // 最后才关日志 —— 上面几步真出错了,那条 error 也得写进去
      await ctx.closeLogger();
    },
  });
};

void bootstrap();
