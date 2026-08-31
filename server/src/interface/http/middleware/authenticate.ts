/**
 * 认证中间件 —— 从 `Authorization` 头取令牌,验签后把主体放进上下文。
 *
 * ── 为什么只认 header,不认 Cookie ─────────────────────────────
 *
 * 凭证不由浏览器自动携带,而是前端每次显式放进请求头。这一条决定带来三个直接后果:
 *   - **没有 CSRF**。跨站页面发起的请求不会带上这个头,所以不需要 origin 白名单,
 *     换 IP、换域名、加个 nginx 都不影响 —— 那些"这不通那不通"的问题根子在 Cookie。
 *   - **不受 Secure / SameSite / Path 管辖**。明文 HTTP 的内网部署一样能用。
 *   - **令牌存在 localStorage,XSS 能读到**。失去了 HttpOnly 的保护,
 *     这是上面两条便利的代价,对应的防线变成严格转义与 CSP。
 */

import type { MiddlewareHandler } from 'hono';
import type { AuthService } from '../../../application/auth/auth.service.js';
import { unauthenticated } from '../../../domain/shared/app-error.js';
import type { AppEnv } from '../env.js';

export const authenticate = (authService: AuthService): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const auth = c.req.header('authorization');
    const token =
      auth !== undefined && auth.toLowerCase().startsWith('bearer ')
        ? auth.slice('bearer '.length).trim()
        : '';

    if (token === '') throw unauthenticated();

    const { actor, expiresAt } = await authService.authenticate(token, c.get('traceId'));
    c.set('actor', actor);

    /*
     * 把过期时刻回给前端,让它能在令牌快过期时提前引导重新登录,
     * 而不是等某个请求突然 401 把用户打断在半路。
     *
     * 用响应头而不是响应体:它对所有端点一致,塞进每个业务响应体里既污染契约
     * 又要每个 toXxxWire 都记得带上。
     */
    c.header('X-Token-Expires-At', expiresAt.toISOString());

    await next();
  };
};
