/**
 * 判断"这个请求实际上是不是走 HTTPS 到达浏览器的"。
 *
 * 干什么: 给 Cookie 的 Secure 标志提供依据。
 *
 * ── 解决什么问题 ──────────────────────────────────────────────
 *
 * Secure 标志一旦加上,浏览器在**明文 HTTP 下会直接丢弃这个 Cookie**,
 * 不报错、不警告。表现是:登录返回 200 且响应里有 Set-Cookie,
 * 紧接着的每个请求都不带 Cookie,于是 /auth/me 401、被踢回登录页、
 * 再登录再 401 —— 循环三次谁都会以为是密码或加密链路出了问题。
 *
 * 以前这里按 `NODE_ENV === 'production'` 判断,隐含假设"生产必然是 HTTPS"。
 * 内网部署根本不成立:`NODE_ENV=production` + `http://192.168.x.x:7001`
 * 会给明文连接发一个带 Secure 的 Cookie,直接导致**完全无法登录**。
 *
 * 改成按请求自身的协议判断,一次配置都不用改就能适应三种部署形态:
 *   直接 HTTP  -> 不加 Secure,能正常登录
 *   直接 HTTPS -> 加 Secure
 *   反代终止 TLS 后转发 HTTP -> 读 X-Forwarded-Proto,仍然加 Secure
 *
 * ── 为什么信任 X-Forwarded-Proto ──────────────────────────────
 *
 * 这个头客户端可以伪造,但伪造它**只会让攻击者给自己的 Cookie 加上更严格的
 * 标志**,拿不到任何好处。反向(伪造成 http 让 Secure 消失)需要攻击者
 * 已经能改写请求头 —— 那是中间人,他本来就能读明文流量,Secure 与否不再是
 * 决定性因素。所有主流框架(Express 的 trust proxy、Django 的
 * SECURE_PROXY_SSL_HEADER)都是这么做的。
 *
 * 真要收紧就用 `COOKIE_SECURE=true` 显式钉死,不依赖探测。
 */

import type { Context } from 'hono';

/**
 * 请求是否经由 HTTPS 到达客户端。
 *
 * [注意] 多级代理会把值拼成 `https, http`,首段才是最靠近客户端的那一跳。
 */
export const isSecureRequest = (c: Context): boolean => {
  const forwarded = c.req.header('x-forwarded-proto');
  if (forwarded !== undefined && forwarded !== '') {
    return forwarded.split(',')[0]?.trim().toLowerCase() === 'https';
  }

  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    // url 解析不了时按不安全处理 —— 宁可 Cookie 少一个标志能登录,
    // 也不要加上标志让人完全登不进去还查不出原因。
    return false;
  }
};

/** Cookie Secure 的取值策略。`'auto'` 按请求协议判断。 */
export type CookieSecureMode = 'auto' | 'always' | 'never';

/** 按策略算出这次响应该不该给 Cookie 加 Secure。 */
export const resolveCookieSecure = (mode: CookieSecureMode, c: Context): boolean => {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return isSecureRequest(c);
};
