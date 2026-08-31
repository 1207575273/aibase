/**
 * 认证域契约 —— 登录、登出、当前用户、改密、权限目录。
 *
 * 所有请求体 schema 一律 z.strictObject:多余字段直接 400 而不是静默丢弃。
 * 静默丢弃的后果是前端传错字段名时"保存成功但没生效",这是最难查的一类 bug。
 */

import { z } from 'zod';
import type { IsoDateString, ItemsEnvelope } from './common.js';
import type { PermissionCode, PermissionGroup } from './permissions.js';

// ── 请求体 ────────────────────────────────────────────────────────

/**
 * 登录请求体。密码有两条通道,**二选一**:
 *
 * - `passwordCipher` —— 浏览器走这条。密码经 RSA+AES 混合加密,
 *   明文不出现在请求体里(也就不出现在 DevTools、nginx body 日志、
 *   WAF 日志、APM 抓包里)。详见 web/src/features/auth/encrypt-password.ts
 * - `password` —— 明文。给 curl 冒烟脚本、运维脚本、e2e 测试用。
 *   生产环境如需强制加密,把 AUTH_REQUIRE_ENCRYPTED_PASSWORD 设为 true,
 *   后端会拒绝这条通道。
 *
 * [重要] 前端加密**不能替代 HTTPS** —— 传输安全靠 TLS。
 * 它解决的是另一类问题:密码在各种中间环节被顺手记进日志,
 * 以及安全测评对"口令加密传输"的硬性要求。
 * 配合一次性 nonce 防重放,否则密文本身就成了新的口令。
 */
export const LoginBodySchema = z
  .strictObject({
    username: z.string().min(1, '请输入用户名').max(64),
    password: z.string().min(1, '请输入密码').max(128).optional(),
    /** 混合加密后的密文,格式见 LoginChallengeResponse 的说明。 */
    passwordCipher: z.string().min(1).max(8192).optional(),
  })
  .refine((v) => (v.password === undefined) !== (v.passwordCipher === undefined), {
    message: 'password 与 passwordCipher 必须且只能提供一个',
    path: ['password'],
  });
export type LoginBody = z.input<typeof LoginBodySchema>;

/**
 * 登录挑战 —— 登录前先取一次,拿到公钥和一次性 nonce。
 *
 * 为什么需要 nonce: 没有它的话,同一段密文可以被无限重放 ——
 * 攻击者不需要知道密码,拿到密文就能登录,等于把密文变成了新口令。
 * nonce 单次有效,用过即废。
 */
export interface LoginChallengeResponse {
  /** 公钥标识。服务重启会换密钥,凭它判断密文用的是不是当前密钥。 */
  keyId: string;
  /** RSA 公钥,SPKI 格式的 base64。前端用 crypto.subtle.importKey 导入。 */
  publicKey: string;
  /** 一次性随机串,必须原样放进加密载荷里回传。 */
  nonce: string;
  /** nonce 有效期(秒)。过期需要重新取挑战。 */
  expiresInSec: number;
}

/**
 * 密码长度域:8~128。
 *
 * 刻意不做大小写/数字/符号的复杂度正则 —— NIST 800-63B 已明确不推荐强制复杂度组合
 * (它促使用户用 Password1! 这类可预测的模式),长度才是真正有效的因素。
 * 上限 128 是防御性的:scrypt 对超长输入没有截断问题,但没必要给 DoS 留面。
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN, `密码至少 ${PASSWORD_MIN} 位`)
  .max(PASSWORD_MAX, `密码最多 ${PASSWORD_MAX} 位`);

/**
 * 登录**表单**的校验规则 —— 与 LoginBodySchema 是两回事,不要混用。
 *
 * LoginBodySchema 描述的是「HTTP 上能发什么」(password 与 passwordCipher 二选一);
 * 这个描述的是「用户必须在表单里填什么」(用户名和密码都得填)。
 * 表单填完之后由前端决定走加密还是明文通道,那一步才产生 LoginBody。
 *
 * 分开定义是因为两者的必填性天然不同 —— 硬套一个会让表单校验失效
 * (password 可选意味着空密码也能提交)。
 */
export const LoginFormSchema = z.strictObject({
  username: z.string().min(1, '请输入用户名').max(64),
  password: z.string().min(1, '请输入密码').max(PASSWORD_MAX),
});
export type LoginForm = z.input<typeof LoginFormSchema>;

export const ChangePasswordBodySchema = z.strictObject({
  oldPassword: z.string().min(1, '请输入原密码'),
  newPassword: PasswordSchema,
});
export type ChangePasswordBody = z.input<typeof ChangePasswordBodySchema>;

// ── 响应 ──────────────────────────────────────────────────────────

/**
 * 登录响应。
 *
 * token 同时通过 HttpOnly Cookie 下发。body 里这一份**仅供非浏览器客户端**
 * (curl 冒烟脚本、运维脚本、未来的移动端)使用。
 * [重要] 前端一律依赖 Cookie,禁止把这个 token 存进 localStorage/sessionStorage ——
 * 存进去就等于把 HttpOnly 提供的 XSS 防护主动放弃掉了。
 */
export interface LoginResponse {
  token: string;
  expiresAt: IsoDateString;
}

export interface MeUserWire {
  id: string;
  username: string;
  displayName: string;
  status: string;
}

export interface MeRoleWire {
  code: string;
  name: string;
}

/**
 * 当前登录者的完整视图。前端的一切权限判断都基于它。
 *
 * permissions 是**每请求实时算出来的**,不是登录时冻结的快照 —— 管理员改了角色权限,
 * 用户下一个请求就生效,不需要重新登录。这是选 Session 而非 JWT 的核心收益。
 */
export interface MeResponse {
  user: MeUserWire;
  roles: MeRoleWire[];
  /** 超级管理员:hasPermission 恒真,新增业务模块自动拥有新权限,不必回头补勾。 */
  superAdmin: boolean;
  /** 数据权限范围。ALL = 全部数据,SELF = 仅本人创建的。 */
  dataScope: string;
  permissions: string[];
}

/** 权限目录:供管理端渲染角色授权页的权限树。由后端从 PERMISSIONS 常量导出。 */
export interface PermissionCatalogItem {
  code: PermissionCode;
  label: string;
}
export interface PermissionCatalogGroup {
  group: PermissionGroup;
  items: PermissionCatalogItem[];
}
export type PermissionCatalogResponse = ItemsEnvelope<PermissionCatalogGroup>;
