/**
 * Hono 应用组装。
 *
 * ── 结构性默认拒绝 ────────────────────────────────────────────
 *
 * 受保护路由全部挂在一个独立的 `secured` 子 app 上,认证中间件挂在它上面一次,
 * 覆盖全部后续路由。新增业务模块的唯一约定就是"挂到 secured 上"。
 *
 * 为什么不逐路由挂 authenticate: 那样"忘了挂"的后果是接口裸奔且**不报任何错**。
 * 物理隔离成两个区之后,公开区里有什么一目了然(就三个),
 * 加任何东西都是显眼的改动,会在 code review 里被看到。
 *
 * [仍然存在的风险] 有人把新路由挂到 app 根上而不是 secured 上,依然会裸奔。
 * 这一点由 app.test.ts 里的回归测试兜住: 遍历所有已注册路由,
 * 逐个发匿名请求,断言除公开区外全部返回 401。那 30 行是整个设计里
 * 性价比最高的代码 —— 漏了它,"默认拒绝"就只是一句口号。
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Logger } from '../lib/logger.js';
import { buildAuthPublicRoutes, buildAuthSecuredRoutes, type AuthRoutesDeps } from '../modules/identity/interfaces/http/auth.routes.js';
import type { AppEnv } from '../platform/http/env.js';
import { handleError, handleNotFound } from '../platform/http/handle-error.js';
import { authenticate } from '../modules/identity/interfaces/http/middleware/authenticate.js';
import { loginRateLimit, type LoginRateLimitOptions } from '../modules/identity/interfaces/http/middleware/login-rate-limit.js';
import { requestContext } from '../platform/http/request-context.js';
import { buildRoleRoutes, type RoleRoutesDeps } from '../modules/identity/interfaces/http/role.routes.js';
import { buildUserRoutes, type UserRoutesDeps } from '../modules/identity/interfaces/http/user.routes.js';

/** 公开区路径。app.test.ts 的默认拒绝回归测试也读这份清单。 */
export const PUBLIC_PATHS = [
  '/health',
  '/version',
  '/auth/login',
] as const;

/**
 * 「已登录即可,不需要任何权限码」的路径。
 *
 * 为什么要显式列出来: app.test.ts 的**授权回归**用一个零权限账号遍历所有受保护路由,
 * 断言全部返回 403。这几条是有意不挂 requirePermission 的 ——
 * 每个登录用户都得能登出、看自己是谁、改自己的密码、拿权限目录渲染界面。
 * 没有这份清单,测试就分不清"故意不挂"和"忘了挂",而后者的后果是
 * 任何登录用户都能调那个接口,且**不报错、测试照样绿**。
 *
 * 往这里加路径与往 PUBLIC_PATHS 加一样,是需要过安全评审的显眼改动。
 */
export const AUTHENTICATED_ONLY_PATHS = [
  '/auth/logout',
  '/auth/me',
  '/auth/change-password',
  '/auth/permission-catalog',
] as const;

export interface AppDeps {
  auth: AuthRoutesDeps;
  user: UserRoutesDeps;
  role: RoleRoutesDeps;
  logger: Logger;
  version: string;
  /** 健康检查用:探活数据库。返回 false 表示数据库不可用。 */
  pingDb: () => Promise<boolean>;
  bodyLimitBytes: number;
  loginRateLimit: LoginRateLimitOptions;
  startedAt: Date;
  clock: () => Date;
}

export const buildApp = (deps: AppDeps): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  // ── 全局中间件。顺序有意义,不要随意调整 ──
  // 1. 请求上下文最先:后面所有东西(含错误处理)都要用 traceId 和 logger
  app.use('*', requestContext(deps.logger));
  // 2. 请求体上限:在解析 body 之前拦掉超大请求,防一个大 JSON 打爆内存
  app.use('*', bodyLimit({ maxSize: deps.bodyLimitBytes }));
  //
  // [没有第 3 条] 这里曾经有 origin 守卫做 CSRF 防线。登录态改成
  // JWT + Authorization 头后凭证不再被浏览器自动携带,跨站页面发的请求
  // 带不上这个头,CSRF 天然不成立,守卫连同 allowedOrigins 配置一起删了。

  // ══ 公开区 ══ 只放这三样。往这里加任何东西都要过安全评审。

  app.get('/health', async (c) => {
    // 真探活,不是返回一个写死的 ok ——
    // 曾见过的一个项目的 /health 只返回静态 {status:'ok'},数据库文件被删/锁死时照样绿,
    // 健康检查等于没有。
    const dbOk = await deps.pingDb();
    const body = {
      status: dbOk ? 'ok' : 'degraded',
      version: deps.version,
      uptimeSec: Math.floor((deps.clock().getTime() - deps.startedAt.getTime()) / 1000),
      db: dbOk ? 'up' : 'down',
    };
    return c.json(body, dbOk ? 200 : 503);
  });

  app.get('/version', (c) =>
    c.json({ version: deps.version, node: process.versions.node }),
  );

  const authPublic = buildAuthPublicRoutes(deps.auth);
  // 限流只挂登录:它是唯一一个未认证就能触发昂贵计算(scrypt 64MiB)的端点
  authPublic.use('/login', loginRateLimit(deps.loginRateLimit));
  app.route('/auth', authPublic);

  // ══ 受保护区 ══ 认证中间件挂一次,覆盖后面全部路由

  const secured = new Hono<AppEnv>();
  secured.use('*', authenticate(deps.auth.service));

  secured.route('/auth', buildAuthSecuredRoutes(deps.auth));
  secured.route('/users', buildUserRoutes(deps.user));
  secured.route('/roles', buildRoleRoutes(deps.role));
  // 新增业务模块只需要在这里加一行

  app.route('/', secured);

  // ── 统一出口。全站只有这一份错误处理 ──
  app.onError(handleError);
  app.notFound(handleNotFound);

  return app;
};
