/**
 * 认证中间件 —— 解析 token,把主体放进 Context。
 *
 * 干什么: 从 Cookie 或 Authorization 头取 token,调 AuthService 换出 ActorContext。
 *
 * 为什么中间件在 interface 层: 它读 HTTP 头、写 Cookie、返回状态码 —— 全是 HTTP 关注点。
 * 它对业务的依赖只有一个注入进来的 AuthService,本身不含任何权限规则
 * (规则在 domain 的 hasPermission)。这保证了两件事都能独立测:
 * 中间件用假 service 测,权限判定脱离 HTTP 测。
 */

import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import type { AuthService } from '../../../application/auth/auth.service.js';
import { unauthenticated } from '../../../domain/shared/app-error.js';
import type { AppEnv } from '../env.js';

export const authenticate = (
  authService: AuthService,
  cookieName: string,
): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    // 两个取 token 的通道:
    // 1. `Authorization: Bearer xxx` —— 给 curl 冒烟脚本、运维脚本、未来的移动端
    // 2. Cookie —— 浏览器唯一通道(HttpOnly,XSS 拿不到)
    // Bearer 优先于 Cookie:显式优先于隐式,调试时可以覆盖掉浏览器里的登录态。
    const auth = c.req.header('authorization');
    const bearer =
      auth !== undefined && auth.toLowerCase().startsWith('bearer ')
        ? auth.slice('bearer '.length).trim()
        : '';
    const token = bearer !== '' ? bearer : getCookie(c, cookieName);

    if (token === undefined || token === '') throw unauthenticated();

    const { actor, sessionId } = await authService.authenticate(token, c.get('traceId'));
    c.set('actor', actor);
    c.set('sessionId', sessionId);

    await next();
  };
};
