/**
 * wire 映射层 —— 把领域对象翻译成 HTTP 上的形状。
 *
 * 干什么: 每个 toXxxWire 函数把一个 domain 实体投影成契约里定义的 DTO。
 *
 * 解决什么问题:
 *   没有这一层的话,路由会直接 `c.json(domainEntity)` —— 领域聚合就**成了公开 API**,
 *   此后 domain 每改一个字段名都是破坏性接口变更,而且 Date 对象、内部字段
 *   (比如 passwordHash!)会全部泄漏到线上。
 *
 *   姊妹项目引入这一层时,编译器当场抓出一个真 bug:某个响应映射漏了两个字段,
 *   导致前端一个功能静默失效。
 *
 * [关键] 每个函数都**显式标注返回类型为契约类型**。这一步不能省 ——
 *   正是它让编译器承担了"wire 形状不漂移"的保证:
 *   契约加了字段而这里没给,编译报错;这里给了契约没有的字段,编译报错。
 *
 * [约定] 三条硬规则(与契约包的声明一致):
 *   1. 时间一律转成 ISO 字符串,线上不出现 Date
 *   2. id 一律裸 string
 *   3. 只映射该暴露的字段 —— passwordHash / tokenHash 这类**永远不出现在这里**
 */

import type {
  MeResponse,
  PageEnvelope,
  PermissionCatalogResponse,
  RoleWire,
  UserWire,
} from '@app/contracts';
import { PERMISSIONS, PERMISSION_GROUPS } from '@app/contracts';
import type { ActorContext } from '../../domain/auth/actor.js';
import type { Role, User } from '../../domain/auth/auth.types.js';
import type { UserWithRoles } from '../../domain/auth/user.repository.js';
import type { RoleWithUserCount } from '../../domain/auth/role.repository.js';
import type { Page } from '../../domain/shared/page.js';

/** 分页信封:把 domain 的 Page<T> 加上请求侧的 page/size 变成完整响应。 */
export const toPageWire = <TDomain, TWire>(
  page: Page<TDomain>,
  query: { page: number; size: number },
  map: (item: TDomain) => TWire,
): PageEnvelope<TWire> => ({
  items: page.items.map(map),
  total: page.total,
  page: query.page,
  size: query.size,
});



// ── 用户 ──────────────────────────────────────────────────────────

/**
 * [安全] 注意这里**没有** passwordHash。
 * 领域实体上有这个字段,wire 上绝不能有 —— 这正是 wire 层存在的价值之一:
 * 直接 c.json(user) 就会把哈希串发给前端。
 */
export const toUserWire = (u: UserWithRoles): UserWire => ({
  id: u.user.id,
  username: u.user.username,
  displayName: u.user.displayName,
  status: u.user.status,
  roles: u.roles.map((r) => ({ id: r.id, code: r.code, name: r.name })),
  createdAt: u.user.createdAt.toISOString(),
  updatedAt: u.user.updatedAt.toISOString(),
  createdBy: u.user.createdBy,
  updatedBy: u.user.updatedBy,
});

// ── 角色 ──────────────────────────────────────────────────────────

export const toRoleWire = (r: RoleWithUserCount): RoleWire => ({
  id: r.role.id,
  code: r.role.code,
  name: r.role.name,
  description: r.role.description,
  superAdmin: r.role.superAdmin,
  builtin: r.role.builtin,
  dataScope: r.role.dataScope,
  permissions: r.role.permissions,
  userCount: r.userCount,
  createdAt: r.role.createdAt.toISOString(),
  updatedAt: r.role.updatedAt.toISOString(),
  createdBy: r.role.createdBy,
  updatedBy: r.role.updatedBy,
});

/** 详情场景没有 userCount(单查一个角色时不值得为它多跑一次 count)。 */
export const toRoleDetailWire = (role: Role, userCount = 0): RoleWire =>
  toRoleWire({ role, userCount });

// ── 当前用户 ──────────────────────────────────────────────────────

export const toMeWire = (
  user: User,
  actor: ActorContext,
  roles: ReadonlyArray<{ code: string; name: string }>,
): MeResponse => ({
  user: {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    status: user.status,
  },
  roles: roles.map((r) => ({ code: r.code, name: r.name })),
  superAdmin: actor.superAdmin,
  dataScope: actor.dataScope,
  permissions: [...actor.permissions],
});

// ── 权限目录 ──────────────────────────────────────────────────────

/**
 * 把权限码常量表按分组整理成权限树,供管理端角色授权页渲染。
 *
 * 这就是"权限码真源在代码"的兑现方式: 新增一个权限码只要在
 * @app/contracts 的 PERMISSIONS 里加一行,这个接口自动就多返回一项,
 * 管理员立刻能勾选。零迁移、零 seed 改动。
 */
export const toPermissionCatalogWire = (): PermissionCatalogResponse => ({
  items: PERMISSION_GROUPS.map((group) => ({
    group,
    items: PERMISSIONS.filter((p) => p.group === group).map((p) => ({
      code: p.code,
      label: p.label,
    })),
  })),
});
