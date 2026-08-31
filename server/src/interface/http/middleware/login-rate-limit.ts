/**
 * 登录限流 —— 内存滑动窗口。
 *
 * 干什么: 限制同一「用户名 + IP」组合在时间窗口内的登录尝试次数。
 *
 * 解决什么问题(两个,都很重要):
 * 1. **密码爆破**。没有限流的话,一个 8 位密码在几小时内可以被穷举。
 * 2. **内存耗尽**。scrypt 单次哈希占约 64MiB —— 10 个并发登录就是 640MiB。
 *    不限流的话,几十个并发登录请求就能打爆容器内存触发重启,这是个廉价的 DoS。
 *    所以对本模板而言限流是**必需品不是加分项**。
 *
 * [限制] 状态在进程内存里。多实例部署时每个实例各算各的,实际阈值被放大 N 倍。
 *   本模板默认单实例所以成立;要多实例时把这个中间件换成 Redis 实现即可 ——
 *   它的接口就是一个 MiddlewareHandler,替换面很小。
 *
 * 为什么不引 hono-rate-limiter: 它是通用限流器,而这里只需要 30 行的专用逻辑,
 *   且要按「用户名+IP」而不是单纯按 IP 限(同一个办公室出口 IP 下有很多人)。
 */

import type { MiddlewareHandler } from 'hono';
import { AUTH_ERROR } from '../../../domain/auth/auth.errors.js';
import { tooManyRequests } from '../../../domain/shared/app-error.js';
import type { Clock } from '../../../domain/shared/clock.js';
import type { AppEnv } from '../env.js';

export interface LoginRateLimitOptions {
  /** 窗口内允许的尝试次数。 */
  limit: number;
  /** 窗口长度(毫秒)。 */
  windowMs: number;
  clock: Clock;
}

/**
 * 取客户端 IP。
 *
 * [注意] X-Forwarded-For 是**客户端可伪造**的头,只有在确知自己跑在
 * 受信任的反向代理后面时才可信。这里用它是因为容器部署几乎总有一层代理,
 * 而且限流的失败模式是"少限了某个人",不是安全边界被击穿。
 * 真正的安全边界是密码本身 + 会话 token。
 */
const clientIp = (c: { req: { header: (n: string) => string | undefined } }): string => {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded !== undefined && forwarded !== '') {
    // XFF 是逗号分隔的链,第一个是最初的客户端
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }
  return c.req.header('x-real-ip') ?? 'unknown';
};

export const loginRateLimit = (options: LoginRateLimitOptions): MiddlewareHandler<AppEnv> => {
  /** key -> 该 key 在窗口内的尝试时间戳列表。 */
  const attempts = new Map<string, number[]>();

  /**
   * 清理过期条目。
   * 不清的话这个 Map 会随着不同用户名/IP 组合无限增长 —— 一个慢速内存泄漏,
   * 而且攻击者可以靠随机用户名主动放大它。
   */
  const sweep = (now: number): void => {
    for (const [key, times] of attempts) {
      const fresh = times.filter((t) => now - t < options.windowMs);
      if (fresh.length === 0) attempts.delete(key);
      else attempts.set(key, fresh);
    }
  };

  let lastSweep = 0;

  return async (c, next) => {
    const now = options.clock().getTime();

    // 每个窗口清理一次即可,不必每请求都遍历整个 Map。
    if (now - lastSweep > options.windowMs) {
      sweep(now);
      lastSweep = now;
    }

    // 读用户名做 key 的一部分。这里要 clone 一份 body ——
    // c.req.json() 在 Hono 里是可以重复调用的(内部缓存),所以下游 handler 还能再读。
    let username = '';
    try {
      const body = (await c.req.json()) as { username?: unknown };
      if (typeof body.username === 'string') username = body.username;
    } catch {
      // body 不是合法 JSON:交给下游的 zod 去报 400,这里只按 IP 限流
    }

    const key = `${username}|${clientIp(c)}`;
    const times = (attempts.get(key) ?? []).filter((t) => now - t < options.windowMs);

    if (times.length >= options.limit) {
      const retryAfterSec = Math.ceil((options.windowMs - (now - (times[0] ?? now))) / 1000);
      c.header('Retry-After', String(retryAfterSec));
      c.get('logger').warn('登录尝试过于频繁', { username, ip: clientIp(c) });
      throw tooManyRequests(
        AUTH_ERROR.TOO_MANY_ATTEMPTS,
        `登录尝试过于频繁,请 ${retryAfterSec} 秒后再试`,
      );
    }

    // 先记一次再放行 —— 无论成败都计数。
    // 只记失败的话,攻击者可以用一个已知的正确账号"刷掉"计数器。
    times.push(now);
    attempts.set(key, times);

    await next();

    // 登录成功就把这个 key 的计数清掉,避免正常用户输错几次后
    // 即使登录成功了仍被后续的限流卡住。
    if (c.res.status < 400) attempts.delete(key);
  };
};
