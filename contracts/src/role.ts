/**
 * 角色域契约 —— RBAC 的中间层:用户挂角色,角色挂权限码。
 *
 * 刻意不做「用户直授权限」: 那会让"这个人为什么有这个权限"变成无法回答的问题,
 * 并且很快退化成人人一个专属角色。需要例外时,新建一个角色。
 */

import { z } from 'zod';
import { PageQuerySchema, type AuditWire, type PageEnvelope } from './common.js';
import { PERMISSION_CODES } from './permissions.js';

/**
 * 数据权限范围(行级权限)。
 *
 * 模板只做最小可运行的两档。DEPT / DEPT_AND_CHILD / CUSTOM 这些档位需要组织架构表,
 * 模板里没有部门也不该有 —— 但四个扩展锚点已经全部预埋好:
 *   1. 这个枚举    2. 业务表的 createdBy 列
 *   3. Repository 查询条件里的 createdBy 过滤位    4. Service 里的注入点
 * 将来加部门维度是「加值不改结构」: 枚举加两个值、ActorContext 多带 deptIds、
 * 那个 guard 从二选一变成 switch。签名、分层、接口形状都不动。
 */
export const DATA_SCOPES = ['ALL', 'SELF'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

export const DATA_SCOPE_LABELS: Record<DataScope, string> = {
  ALL: '全部数据',
  SELF: '仅本人创建',
};

export interface RoleWire extends AuditWire {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** true 时 hasPermission 恒真。允许存在多个超管角色,比通配符权限码更显式可审计。 */
  superAdmin: boolean;
  /** 内置角色:禁止删除、禁止改 code,但可以改名字和权限集合。 */
  builtin: boolean;
  dataScope: DataScope;
  permissions: string[];
  /** 当前挂在这个角色下的用户数。删除前的 ROLE_IN_USE 判断依据。 */
  userCount: number;
}

export type RoleListResponse = PageEnvelope<RoleWire>;

/**
 * 角色码值域: 大写字母 + 下划线。
 * 与权限码(小写冒号分隔)刻意用不同的形态,读日志时一眼能分清是角色还是权限。
 */
export const RoleCodeSchema = z
  .string()
  .trim()
  .min(2, '角色码至少 2 位')
  .max(32, '角色码最多 32 位')
  .regex(/^[A-Z][A-Z0-9_]*$/, '角色码须大写字母开头,只能包含大写字母、数字、下划线');

/**
 * 权限码数组。用 z.enum(PERMISSION_CODES) 而不是 z.string():
 * 前端传了一个代码里不存在的权限码会直接 400,而不是静默写进库里变成永远不生效的脏数据。
 */
const PermissionListSchema = z
  .array(z.enum(PERMISSION_CODES))
  .max(PERMISSION_CODES.length);

export const CreateRoleBodySchema = z.strictObject({
  code: RoleCodeSchema,
  name: z.string().trim().min(1, '角色名不能为空').max(64),
  description: z
    .string()
    .max(200)
    .transform((v) => (v.trim() === '' ? null : v.trim()))
    .nullish()
    .transform((v) => v ?? null),
  dataScope: z.enum(DATA_SCOPES).default('ALL'),
  permissions: PermissionListSchema.default([]),
});
export type CreateRoleBody = z.input<typeof CreateRoleBodySchema>;

/** 授权折叠进 update,不另开 /assign-permissions 端点(理由同用户域)。code 不可改。 */
export const UpdateRoleBodySchema = CreateRoleBodySchema.omit({ code: true });
export type UpdateRoleBody = z.input<typeof UpdateRoleBodySchema>;

export const RoleListQuerySchema = PageQuerySchema.extend({
  keyword: z.string().trim().max(64).optional(),
});
export type RoleListQuery = z.input<typeof RoleListQuerySchema>;
