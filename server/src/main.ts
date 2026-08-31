/**
 * 后端入口。
 *
 * 只做四件事: 建上下文 -> 装配模块 -> 建 app -> 监听。
 *
 * [约束] 这个文件不随业务增长 —— **加业务模块改的是 composition/modules.ts,不是这里**。
 * 它只在"多一种运行形态"(比如加个 WebSocket 挂载)时才会变长。
 * 超过约 150 行说明有运行时关注点该挪进 bootstrap/ 了。
 * (对照: 姊妹项目 work_nm_tp 的 main.ts 有 1173 行,因为 12 个域的装配全塞在里面。)
 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerShutdown } from './bootstrap/shutdown.js';
import { config, REPO_ROOT } from './config/index.js';
import { accessUrls } from './infrastructure/system/access-urls.js';
import { createContext } from './composition/context.js';
import { buildModules } from './composition/modules.js';
import { buildApp } from './interface/http/app.js';
import type { AppEnv } from './interface/http/env.js';

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


  // 挂载。两种维度组合:
  //   - contextPath: '' 挂根 / '/app' 整体挂子路径(见 ports.json)
  //   - SERVE_WEB:   设了就同时托管前端(生产单端口),不设就是纯 API(开发态)
  // 四种组合共用同一份代码,没有条件编译。
  const root = new Hono<AppEnv>();

  // API 一律挂 ${contextPath}/api。config.apiPrefix 与前端 axios 的 baseURL
  // 取的是同一份 ports.json,两边不会漂。
  root.route(config.apiPrefix, app);

  if (config.serveWebDir !== undefined) {
    const webRoot = resolve(REPO_ROOT, config.serveWebDir);

    // [坑] Hono 的 route(prefix) 挂载**不会改写 c.req.path** ——
    // serveStatic 会拿到含前缀的完整路径去拼磁盘路径(webRoot + /app/assets/x.js),
    // 结果永远 miss,全部落到 SPA fallback 返回 HTML。
    // 现象是"页面能开但所有 js/css 都变成 index.html 的内容"。
    // 必须用 rewriteRequestPath 把前缀剥掉再解析磁盘路径。
    const rewriteRequestPath = (p: string): string =>
      config.contextPrefix !== '' && p.startsWith(config.contextPrefix)
        ? p.slice(config.contextPrefix.length) || '/'
        : p;

    const web = config.contextPrefix === '' ? root : new Hono<AppEnv>();
    web.use('/*', serveStatic({ root: webRoot, rewriteRequestPath }));
    // SPA fallback: /persons 这类前端路由不是真实文件,回 index.html 交给前端路由处理。
    // [注意] 必须挂在 API 之后 —— 否则 API 的 404 会被这里接住返回 HTML,
    // 前端拿到一坨 HTML 去 JSON.parse,报出来的错与真实原因完全无关。
    web.get('*', serveStatic({ path: `${webRoot}/index.html` }));

    if (config.contextPrefix !== '') root.route(config.contextPrefix, web);
  }

  const server = serve({ fetch: root.fetch, port: config.port, hostname: config.host }, (info) => {
    logger.info('服务已启动', {
      // 绑 0.0.0.0 时列出全部网卡地址,而不是打印一个没法直接点的 "0.0.0.0:7001" ——
      // 部署到服务器或容器里时,这几行就是运维确认"到底该访问哪个地址"的依据
      urls: accessUrls(info.port, config.host, config.contextBase),
      health: `${config.apiPrefix}/health`,
      env: config.nodeEnv,
      db: config.dbPath,
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
