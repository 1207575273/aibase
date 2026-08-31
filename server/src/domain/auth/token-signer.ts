/**
 * 访问令牌签发与验证端口。
 *
 * ── 为什么从「会话查库」换成 JWT ────────────────────────────────
 *
 * 原方案是 opaque token + Session 表:每个请求拿 token 查库换主体。
 * 它换来的是强制下线与权限即时生效,代价是**登录态必须靠 Cookie 承载**,
 * 而 Cookie 自动携带这一条特性引出一长串部署期问题:
 *   - Secure 标志在明文 HTTP 下被浏览器静默丢弃 -> 内网部署完全登不进去
 *   - 自动携带意味着必须防 CSRF -> origin-guard 白名单 -> 换个 IP 就被拒
 *   - Path 还要跟着 contextPath 走,多应用同域时互相覆盖
 * 这些问题的根都在「浏览器替你带凭证」,而不在「token 要不要查库」。
 *
 * 改成 JWT + `Authorization` 头之后,凭证由前端显式携带:
 * 浏览器不会自动带,CSRF 天然不存在,Secure/SameSite/Path 全部不再相关,
 * 换任何 IP、任何域名、HTTP 还是 HTTPS 都一样能用。
 *
 * ── 有意接受的代价 ────────────────────────────────────────────
 *
 * 1. **改权限不立即生效**。权限写在 token 载荷里,要等它过期重签才更新。
 *    需要立刻生效时让用户重新登录。
 * 2. **无法强制下线**。签出去的 token 在有效期内始终有效,服务端不持有状态,
 *    没有可吊销的对象。要吊销就得建吊销表,那等于绕回查库,失去换 JWT 的全部意义。
 * 3. **token 存 localStorage,XSS 可读**。Cookie 的 HttpOnly 保护随之失去 ——
 *    这是「不让浏览器自动带凭证」的另一面,两者不可兼得。
 *    对应的防线变成:严格转义、不用 innerHTML、CSP。
 *
 * 这三条是选 JWT 时一并选下的,不是疏漏。要拿回它们只能换回会话查库。
 */

/** JWT 载荷里承载的主体信息。与 ActorContext 同源,但用可序列化的形状。 */
export interface TokenClaims {
  /** 用户 id。 */
  sub: string;
  username: string;
  roleCodes: readonly string[];
  superAdmin: boolean;
  /** 'ALL' | 'SELF',与 domain/auth/actor.ts 的 DataScope 一致。 */
  dataScope: string;
  /** 权限码。超管为空数组 —— 它靠 superAdmin 恒真,不需要枚举。 */
  permissions: readonly string[];
}

/** 验签结果。失败时给出原因,便于日志区分「过期」与「伪造」。 */
export type VerifyResult =
  | { ok: true; claims: TokenClaims; expiresAt: Date }
  | { ok: false; reason: 'expired' | 'invalid' };

export interface TokenSigner {
  /**
   * 签发访问令牌。
   * @returns 令牌本身与它的过期时刻(过期时刻要回给前端,用于提前续期)
   */
  sign(claims: TokenClaims): { token: string; expiresAt: Date };

  /**
   * 验证并解出载荷。
   *
   * 实现必须做到:
   *   - 校验签名算法头,拒绝 `alg: none` 与任何非约定算法
   *   - 用恒定时间比较签名,不用 `===`
   *   - 校验过期时间
   */
  verify(token: string): VerifyResult;
}
