/**
 * Origin 白名单守卫 —— CSRF 主防线。
 *
 * 干什么: 拒绝来自非白名单站点的写请求(POST)。
 *
 * 为什么必须有:
 *   本模板用 Cookie 承载登录态。浏览器在跨站请求时**会自动带上 Cookie** ——
 *   这意味着恶意站点上的一段 `fetch('http://你的服务/api/users/xxx/delete', {credentials:'include'})`
 *   会以受害者的身份执行。SameSite=Lax 挡住了大部分场景,但这一层是显式的、
 *   不依赖浏览器实现差异的防线。
 *
 * [重要] 启用 Cookie 认证后,**本中间件不可移除**。
 *
 * 判定规则(按顺序):
 * 1. 非 POST 一律放行 —— GET 在本模板里都是幂等只读的(HTTP 只用 GET/POST 的约定
 *    让这条判断成立;如果有人写了"GET 触发删除",这条就失效了,所以那是禁止的)。
 * 2. 无 Origin 头 -> 放行。这是**有意接受的风险**: 现代浏览器发起跨源 POST 必带
 *    Origin 头,没有 Origin 的通常是 curl / 服务端调用 / 同源的老浏览器。
 *    对它们的防护由"必须带 token"这一条承担。
 * 3. Origin 的 host 与请求的 Host 相同 -> 同源,放行。
 *    这一条比枚举端口耐用得多:单端口生产、反向代理、局域网 IP 访问全都自动成立,
 *    部署形态变了不需要改白名单。
 * 4. 在显式白名单里 -> 放行(开发态 vite dev server 跨端口用)。
 * 5. 其余拒绝。
 */

import type { MiddlewareHandler } from 'hono';
import { forbidden } from '../../../domain/shared/app-error.js';
import type { AppEnv } from '../env.js';

export interface OriginGuardOptions {
  /** 额外允许的完整源,如 http://localhost:7002。开发态用。 */
  allowedOrigins: readonly string[];
}

export const originGuard = (options: OriginGuardOptions): MiddlewareHandler<AppEnv> => {
  const allowed = new Set(options.allowedOrigins);

  return async (c, next) => {
    if (c.req.method !== 'POST') {
      await next();
      return;
    }

    const origin = c.req.header('origin');
    if (origin === undefined || origin === '') {
      await next();
      return;
    }

    if (allowed.has(origin)) {
      await next();
      return;
    }

    // 同源判定:比较 host(含端口)。用 URL 解析而不是字符串拼接 ——
    // Origin 是 `scheme://host:port`,Host 头是 `host:port`,形态不同。
    const host = c.req.header('host');
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      // Origin 解析不了说明是伪造的,直接拒
      throw forbidden('请求来源不被信任', { origin });
    }

    if (host !== undefined && originHost === host) {
      await next();
      return;
    }

    c.get('logger').warn('拒绝跨源写请求', { origin, host, path: c.req.path });
    throw forbidden('请求来源不被信任', { origin });
  };
};
