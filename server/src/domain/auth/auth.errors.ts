/**
 * 认证 / 授权域错误码。
 *
 * 这些码值是**对外契约的一部分** —— 前端按码分支处理(比如 TOKEN_EXPIRED
 * 要静默跳登录页并提示"登录已过期",UNAUTHENTICATED 直接跳登录页)。改码值等于改接口。
 */
export const AUTH_ERROR = {
  /**
   * 用户名或密码错误。
   * [安全] 用户不存在与密码错误**必须返回同一个码和同一句文案** ——
   * 区分开就等于提供了一个用户名枚举接口。
   */
  INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',

  /** 未登录,或 token 无效。刻意不区分"token 不存在"与"token 已被删",不给枚举线索。 */
  UNAUTHENTICATED: 'UNAUTHENTICATED',

  /** token 过期。与 UNAUTHENTICATED 分开是为了前端能给"登录已过期"的友好文案。 */
  TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',

  /** 账号被禁用。403 而不是 401 —— 重新登录也没用,不该让用户陷入登录死循环。 */
  USER_DISABLED: 'AUTH_USER_DISABLED',

  /** 登录尝试过于频繁。 */
  TOO_MANY_ATTEMPTS: 'AUTH_TOO_MANY_ATTEMPTS',

  /**
   * 登录挑战失效(nonce 过期/已用过,或服务重启换了密钥)。
   * 与 INVALID_CREDENTIALS 分开是为了让前端能**自动重取挑战并重试一次**,
   * 而不是把"服务刚重启过"显示成"密码错误"让用户白白怀疑自己。
   */
  LOGIN_KEY_EXPIRED: 'AUTH_LOGIN_KEY_EXPIRED',

  /** 该环境要求密码加密传输,但收到的是明文。 */
  PLAINTEXT_PASSWORD_REJECTED: 'AUTH_PLAINTEXT_PASSWORD_REJECTED',

  /** 改密时原密码不对。 */
  OLD_PASSWORD_MISMATCH: 'AUTH_OLD_PASSWORD_MISMATCH',

  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USERNAME_TAKEN: 'USER_USERNAME_TAKEN',
  /** 不允许删除自己 —— 删完就没人能管理系统了。 */
  CANNOT_DELETE_SELF: 'USER_CANNOT_DELETE_SELF',
  /** 不允许禁用自己,理由同上。 */
  CANNOT_DISABLE_SELF: 'USER_CANNOT_DISABLE_SELF',

  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  ROLE_CODE_TAKEN: 'ROLE_CODE_TAKEN',
  /** 仍有用户持有该角色。 */
  ROLE_IN_USE: 'ROLE_IN_USE',
  /** 内置角色禁止删除 / 禁止改 code。 */
  BUILTIN_ROLE_READONLY: 'ROLE_BUILTIN_READONLY',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR)[keyof typeof AUTH_ERROR];
