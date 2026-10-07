/**
 * 角色仓储端口。
 */

import type { Page, PageParams } from '../../../lib/page.js';
import type { Role } from './auth.types.js';

/** 角色 + 当前持有人数。列表页要显示"多少人在用",删除前也要靠它判断。 */
export interface RoleWithUserCount {
  role: Role;
  userCount: number;
}

export interface RoleListFilter extends PageParams {
  /** 同时匹配 code 与 name。 */
  keyword?: string | undefined;
  /**
   * 行级数据权限的过滤锚点:只返回 createdBy 等于它的行。
   * undefined = 不限制。由 Service 用 scopeOwnerOf(actor) 算出后传入。
   */
  scopeOwnerId?: string | undefined;
}

export interface RoleRepository {
  /** code 唯一由数据库约束保证,实现需把 P2002 翻译成 conflict。 */
  create(role: Role): Promise<void>;

  findById(id: string): Promise<Role | null>;

  /**
   * 按 id 批量查。用于"这批角色 id 是否都存在"这类校验 ——
   * 调用方遍历 id 逐个 findById 就是 N+1,建号/改用户两条主路径都会走到。
   * 返回的顺序不保证,不存在的 id 不会出现在结果里(调用方据此算差集)。
   */
  findByIds(ids: readonly string[]): Promise<Role[]>;

  /** 按角色码查找(唯一索引)。seed 幂等写入时用。 */
  findByCode(code: string): Promise<Role | null>;

  /**
   * 分页列表,按 builtin 倒序 + createdAt 正序 —— 内置角色永远排在最前面。
   * filter.scopeOwnerId 有值时必须按 createdBy 过滤,total 同口径。
   */
  list(filter: RoleListFilter): Promise<Page<RoleWithUserCount>>;

  /**
   * 全部角色,不分页。用于用户编辑页的角色多选框 —— 角色数量业务上就是有限的。
   *
   * [有意豁免行级权限] 这里**不做** scopeOwnerId 过滤,与 list() 不同。
   * 它返回的是「可分配的角色目录」而不是「我管理的数据」,且只暴露 id/code/name
   * 三个非敏感字段。做了过滤的话,一个 dataScope=SELF 的管理员将无法给用户分配
   * 任何内置角色(seed 灌的 ADMIN/VIEWER 的 createdBy 是 null),
   * 建号功能直接不可用 —— 那是把权限模型的严谨性换成了功能残废。
   * 调用它仍然需要 user:read 权限,不是匿名可达。
   */
  listAllForPicker(): Promise<Array<Pick<Role, 'id' | 'code' | 'name'>>>;

  /**
   * 更新角色。permissions 传入时全量替换(先删后插)。
   * updatedAt / updatedBy 由 Service 显式传入。
   */
  update(
    id: string,
    patch: Partial<Pick<Role, 'name' | 'description' | 'dataScope' | 'updatedAt' | 'updatedBy'>>,
    permissions?: readonly string[],
  ): Promise<void>;

  /**
   * 硬删除。调用方必须先确认无人持有(ROLE_IN_USE)——
   * 数据库侧 user_role.roleId 是 onDelete: Restrict,会在竞态下兜底拒绝。
   */
  delete(id: string): Promise<void>;
}
