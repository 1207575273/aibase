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
  type PermissionCatalogResponse,
} from '@app/contracts';
import { Hono } from 'hono';
import type { AuthService } from '../../application/auth.service.js';
import { unauthenticated } from '../../../../lib/app-error.js';
import { getActor, type AppEnv } from '../../../../platform/http/env.js';
import { toMeWire, toPermissionCatalogWire } from './wire.js';
import { validate } from '../../../../platform/http/validator.js';

export interface AuthRoutesDeps {
  service: AuthService;
}

export const buildAuthPublicRoutes = (deps: AuthRoutesDeps): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  app.post('/login', validate('json', LoginBodySchema), async (c) => {
    const { username, password } = c.req.valid('json');

    const result = await deps.service.login({
      username,
      password,
      userAgent: c.req.header('user-agent'),
      ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip'),
    });

    /*
     * 令牌只在响应体里返回,不种 Cookie。
     *
     * 前端把它存进 localStorage 并在后续请求放进 Authorization 头。
     * 这么做失去了 HttpOnly 的 XSS 防护,换来的是「凭证不被浏览器自动携带」——
     * 于是 CSRF、Secure 标志、SameSite、Cookie Path 这一整类部署期问题全部消失,
     * 换 IP / 换域名 / 明文 HTTP 都能直接用。取舍见 ../../domain/token-signer.ts。
     */
    const body: LoginResponse = {
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
    };
    return c.json(body);
  });


  return app;
};

export const buildAuthSecuredRoutes = (deps: AuthRoutesDeps): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  /**
   * 登出。
   *
   * [注意] 服务端在 JWT 方案下**没有可清理的状态** —— 令牌是自验证的,签出去就收不回。
   * 真正的登出发生在前端:把 localStorage 里的令牌删掉。
   * 这个端点保留是为了给前端一个统一调用点(将来加登出审计有地方挂)。
   */
  app.post('/logout', async (c) => {
    const token = bearerOf(c.req.header('authorization'));
    if (token !== undefined) await deps.service.logout(token);
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
    await deps.service.changePassword(c.req.valid('json'), getActor(c));
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
