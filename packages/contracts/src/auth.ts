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
 * 登录请求体。密码明文提交,传输安全由 HTTPS 负责。
 *
 * [已移除] 前端 RSA+AES 加密密码(等保「口令加密传输」)。浏览器只在 https/localhost
 * 暴露 crypto.subtle,内网 http 访问时本来就退回明文;上了 https 之后它只剩
 * "日志里看不到密码"的价值,却要 600 行代码与启动期异步生成密钥。
 * 有项目必须过等保时从 git 历史恢复,不要在基座里常驻。
 */
export const LoginBodySchema = z.strictObject({
  username: z.string().min(1, '请输入用户名').max(64),
  password: z.string().min(1, '请输入密码').max(128),
});
export type LoginBody = z.input<typeof LoginBodySchema>;

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
 * LoginBodySchema 描述的是「HTTP 上能发什么」,这个描述的是「用户必须在表单里填什么」。
 * 两者现在字段相同,仍分开定义:表单的提示文案与校验时机属于前端交互,
 * 请求体属于接口契约,一方改动不应牵连另一方。
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
 * token 只在这个响应体里下发一次,**不种 Cookie**。所有客户端(浏览器、curl、
 * 运维脚本、将来的移动端)走的都是同一条通道:自己保存它,后续请求放进
 * `Authorization: Bearer <token>` 头。
 *
 * 浏览器端存 localStorage。这么做失去了 HttpOnly 的 XSS 防护,换来的是
 * 「凭证不被浏览器自动携带」—— CSRF、Secure 标志、SameSite、Cookie Path
 * 这一整类部署期问题随之消失。取舍的完整论证见
 * server/src/modules/identity/domain/token-signer.ts 的头注释。
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
 * [重要] permissions 与 dataScope 是**登录那一刻固化进 JWT 载荷的快照**,
 * 不是每请求实时算的。管理员改了这个用户的角色、或改了角色的权限,
 * 都要等令牌过期重新签发才生效(默认 7 天,由 JWT_TTL_SECONDS 控制)。
 * 这是选 JWT 而非会话查库的代价之一,不是 bug。
 *
 * user 那部分则是每次查库的(显示名会被改),所以 /me 不是纯粹的零查询接口。
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
