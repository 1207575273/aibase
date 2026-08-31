/**
 * 访问令牌的本地存放处。
 *
 * ── 为什么是 localStorage 而不是 Cookie ───────────────────────
 *
 * Cookie 由浏览器自动携带,那一条特性带来的问题比它省下的代码多得多:
 * 必须防 CSRF(于是要维护 origin 白名单,换个 IP 就被拒)、受 Secure 标志管辖
 * (明文 HTTP 的内网部署下浏览器会静默丢弃它,表现为"登录成功却立刻 401")、
 * Path 还要跟着 contextPath 走。
 *
 * 改成前端显式携带之后这些全部消失。代价是**XSS 能读到令牌**——
 * 这是 HttpOnly 保护的失去,不可兼得。对应的防线换成:
 * 不用 innerHTML、不 eval 用户输入、上线时配 CSP。
 *
 * 用 localStorage 而不是 sessionStorage:后者关掉标签页就没了,
 * 每次打开都要重新登录,对内网业务系统来说太吵。
 */

const KEY = 'app.token';
const EXPIRES_KEY = 'app.token.expiresAt';

/**
 * 提前多久算"快过期了"。
 *
 * 用于让界面在令牌失效前引导用户重新登录,而不是等某个请求突然 401
 * 把人打断在填表填一半的时候。
 */
const RENEW_WINDOW_MS = 30 * 60 * 1000;

export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(KEY);
    } catch {
      // 隐私模式 / 存储被禁用时 localStorage 会抛。此时退化成"未登录",
      // 而不是让整个应用白屏。
      return null;
    }
  },

  save(token: string, expiresAt: string): void {
    try {
      localStorage.setItem(KEY, token);
      localStorage.setItem(EXPIRES_KEY, expiresAt);
    } catch {
      // 同上:存不进去也不该崩,只是刷新后要重新登录
    }
  },

  clear(): void {
    try {
      localStorage.removeItem(KEY);
      localStorage.removeItem(EXPIRES_KEY);
    } catch {
      // 忽略
    }
  },

  /** 令牌是否已过期或即将过期。没有令牌时返回 true。 */
  isExpiringSoon(): boolean {
    try {
      const raw = localStorage.getItem(EXPIRES_KEY);
      if (raw === null) return true;
      const at = new Date(raw).getTime();
      if (Number.isNaN(at)) return true;
      return at - Date.now() < RENEW_WINDOW_MS;
    } catch {
      return true;
    }
  },
};
