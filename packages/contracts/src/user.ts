/**
 * 用户域契约 —— 系统用户的增删改查与角色分配。
 */

import { z } from 'zod';
import { PageQuerySchema, type AuditWire, type PageEnvelope } from './common.js';
import { PasswordSchema } from './auth.js';

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  ACTIVE: '正常',
  DISABLED: '已禁用',
};

export interface UserRoleWire {
  id: string;
  code: string;
  name: string;
}

export interface UserWire extends AuditWire {
  id: string;
  username: string;
  displayName: string;
  status: UserStatus;
  roles: UserRoleWire[];
}

export type UserListResponse = PageEnvelope<UserWire>;

/**
 * 用户名值域: 字母开头,字母数字下划线,3~32 位。
 *
 * 限制得比较死是有意的 —— 用户名会出现在日志、URL、审计记录里,
 * 允许任意 Unicode 会带来一整类编码与展示问题。显示用的名字走 displayName。
 */
export const UsernameSchema = z
  .string()
  .trim()
  .min(3, '用户名至少 3 位')
  .max(32, '用户名最多 32 位')
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, '用户名须字母开头,只能包含字母、数字、下划线');

export const CreateUserBodySchema = z.strictObject({
  username: UsernameSchema,
  displayName: z.string().trim().min(1, '显示名不能为空').max(64),
  password: PasswordSchema,
  roleIds: z.array(z.string()).default([]),
});
export type CreateUserBody = z.input<typeof CreateUserBodySchema>;

/**
 * 更新用户。角色分配与启用/禁用都折叠进这一个端点,不另开
 * /assign-roles、/enable、/disable 三个接口 —— 那样前端要发三次请求,
 * 且三个动作之间没有事务边界。
 *
 * username 不可改: 它是审计日志里的主体标识,改了会让历史日志对不上人。
 */
export const UpdateUserBodySchema = z.strictObject({
  displayName: z.string().trim().min(1, '显示名不能为空').max(64),
  status: z.enum(USER_STATUSES),
  roleIds: z.array(z.string()),
});
export type UpdateUserBody = z.input<typeof UpdateUserBodySchema>;

/** 管理员重置密码:无需提供原密码,但会踢掉该用户全部在线会话。 */
export const ResetPasswordBodySchema = z.strictObject({
  newPassword: PasswordSchema,
});
export type ResetPasswordBody = z.input<typeof ResetPasswordBodySchema>;

/**
 * 用户**表单**的校验规则 —— 与上面两个请求体 schema 是三回事,不要混用。
 *
 * ── 为什么必须单独定义 ────────────────────────────────────────
 *
 * 请求体 schema 是 `z.strictObject`(多余字段直接 400,这是有意的),
 * 而表单**始终持有全部字段** —— 新增和编辑共用一个组件,
 * `username` / `password` / `status` 一直在表单状态里。
 *
 * 直接拿请求体 schema 当 resolver 的后果:
 *   - 编辑模式:`username`、`password` 被判为"未知的键" -> 校验失败
 *   - 新增模式:`status` 被判为"未知的键" -> 校验失败
 * 而且失败的 issue 挂在**根路径**(path: []),落不到任何输入框上,
 * 页面什么错都不显示 —— 表现就是「点保存没反应」,极难排查。
 * (这个 bug 真实发生过。)
 *
 * ── 分工 ─────────────────────────────────────────────────────
 *   XxxFormSchema  描述「用户在表单里必须填什么」  -> 给 zodResolver
 *   XxxBodySchema  描述「HTTP 上能发什么」          -> 给后端 parse
 * 提交时由组件从表单值里挑出该发的字段,组装成请求体。
 */
export const UserFormSchema = z
  .object({
    username: UsernameSchema,
    displayName: z.string().trim().min(1, '显示名不能为空').max(64),
    /** 编辑模式下不填(改密走独立的重置入口),所以这里允许空串。 */
    password: z.string(),
    status: z.enum(USER_STATUSES),
    roleIds: z.array(z.string()),
  })
  // 表单值由组件自己控制,不是外部输入 —— 不需要 strict。
  // 反而必须非 strict,否则将来加一个纯 UI 字段(比如"确认密码")就会炸。
  .loose();

export type UserFormValues = z.input<typeof UserFormSchema>;

/**
 * 新增模式的表单规则:在通用规则上追加「密码必填且满足长度」。
 * 编辑模式直接用 UserFormSchema(密码留空)。
 */
export const CreateUserFormSchema = UserFormSchema.safeExtend({
  password: PasswordSchema,
});

export const UserListQuerySchema = PageQuerySchema.extend({
  keyword: z.string().trim().max(64).optional(),
  status: z.enum(USER_STATUSES).optional(),
});
export type UserListQuery = z.input<typeof UserListQuerySchema>;
