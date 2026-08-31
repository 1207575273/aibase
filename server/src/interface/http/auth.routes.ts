/**
 * 认证路由。
 *
 * 刻意拆成两个工厂:
 *   buildAuthPublicRoutes  —— 挂在公开区,只有登录
 *   buildAuthSecuredRoutes —— 挂在受保护区,需要已登录
 * 这样"哪些接口不需要登录"在 app.ts 的组装处一目了然,而不是散在各个 handler 里。
 */

import {
  ChangePasswordBodySchema,
  LoginBodySchema,
  type LoginResponse,
  type MeResponse,
  type OkResponse,
  type LoginChallengeResponse,
  type PermissionCatalogResponse,
} from '@app/contracts';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AuthService } from '../../application/auth/auth.service.js';
import { unauthenticated } from '../../domain/shared/app-error.js';
import { getActor, getSessionId, type AppEnv } from './env.js';
import { toMeWire, toPermissionCatalogWire } from './wire.js';
import { validate } from './validator.js';
import { resolveCookieSecure, type CookieSecureMode } from './request-proto.js';

export interface AuthRoutesDeps {
  service: AuthService;
  cookieName: string;
  /**
   * Cookie Secure 标志的取值策略。
   *
   * `'auto'`(默认)按**请求的实际协议**判断,而不是按 NODE_ENV ——
   * 内网 HTTP 部署时 NODE_ENV 同样是 production,按环境判断会给明文连接
   * 发带 Secure 的 Cookie,浏览器静默丢弃,表现为"登录 200 但立刻 401"。
   * 详见 request-proto.ts。
   */
  secureCookie: CookieSecureMode;
  /**
   * Cookie 的 Path。取应用的上下文基路径('/' 或 '/app/')。
   *
   * 为什么不写死 '/': 同一个域名下按路径反代多个应用时,Path=/ 会让
   * 本应用的会话 Cookie 被发送给**同域的其他应用** —— 既是信息泄漏,
   * 也会造成多个应用的同名 Cookie 互相覆盖(登了 A 就把 B 挤下线)。
   */
  cookiePath: string;
}

export const buildAuthPublicRoutes = (deps: AuthRoutesDeps): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  app.post('/login', validate('json', LoginBodySchema), async (c) => {
    const { username, password, passwordCipher } = c.req.valid('json');

    const result = await deps.service.login({
      username,
      password,
      passwordCipher,
      userAgent: c.req.header('user-agent'),
      ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip'),
    });

    setCookie(c, deps.cookieName, result.token, {
      // HttpOnly: JS 读不到,XSS 拿不走 token。这是选 Cookie 而非 localStorage
      // 的唯一理由,也是足够的理由。
      httpOnly: true,
      // Lax 而非 Strict: Strict 会让"从邮件链接点进系统"的首次导航不带 Cookie,
      // 用户会被莫名其妙踢到登录页。Lax 已经挡住了所有跨站 POST。
      sameSite: 'Lax',
      secure: resolveCookieSecure(deps.secureCookie, c),
      // 跟随 contextPath,不写死 —— 见 cookiePath 的说明
      path: deps.cookiePath,
      expires: result.expiresAt,
    });

    // body 里也返回 token,但**仅供非浏览器客户端**(curl 脚本、运维工具)。
    // 前端一律依赖 Cookie,禁止把它存进 localStorage —— 存了就等于
    // 主动放弃 HttpOnly 提供的 XSS 防护。
    const body: LoginResponse = {
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
    };
    return c.json(body);
  });


  /**
   * 登录挑战。公开端点 —— 未登录时当然拿不到 token,所以它必须能匿名访问。
   *
   * 返回的公钥是**公开信息**,泄漏它没有任何风险(这正是非对称加密的意义)。
   * nonce 是一次性的,拿到也只能用一次,且必须配合正确的密码才有用。
   */
  app.get('/login-challenge', (c) => {
    const body: LoginChallengeResponse = deps.service.issueLoginChallenge();
    return c.json(body);
  });

  return app;
};

export const buildAuthSecuredRoutes = (deps: AuthRoutesDeps): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  app.post('/logout', async (c) => {
    const token = getCookie(c, deps.cookieName) ?? bearerOf(c.req.header('authorization'));
    if (token !== undefined) await deps.service.logout(token);

    // 删除时要带上与写入时一致的属性,否则浏览器可能匹配不到那个 Cookie
    deleteCookie(c, deps.cookieName, {
      path: deps.cookiePath,
      secure: resolveCookieSecure(deps.secureCookie, c),
    });
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  app.get('/me', async (c) => {
    const actor = getActor(c);
    const user = await deps.service.me(actor);
    // roles 只有 code(actor 里就这些),name 需要的话前端从角色列表取。
    // 这里保持轻量:/me 是每次进页面都要调的接口。
    const body: MeResponse = toMeWire(
      user,
      actor,
      actor.roleCodes.map((code) => ({ code, name: code })),
    );
    return c.json(body);
  });

  app.post('/change-password', validate('json', ChangePasswordBodySchema), async (c) => {
    await deps.service.changePassword(c.req.valid('json'), getActor(c), getSessionId(c));
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  /** 权限目录:供角色授权页渲染权限树。数据来自代码常量,不查库。 */
  app.get('/permission-catalog', (c) => {
    const body: PermissionCatalogResponse = toPermissionCatalogWire();
    return c.json(body);
  });

  return app;
};

const bearerOf = (header: string | undefined): string | undefined => {
  if (header === undefined || !header.toLowerCase().startsWith('bearer ')) return undefined;
  const token = header.slice('bearer '.length).trim();
  return token === '' ? undefined : token;
};

/** 供其他模块复用的未登录错误(保持错误码一致)。 */
export const requireLogin = (): never => {
  throw unauthenticated();
};
