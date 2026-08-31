/**
 * 角色仓储端口。
 */

import type { Page, PageParams } from '../shared/page.js';
import type { Role } from './auth.types.js';

/** 角色 + 当前持有人数。列表页要显示"多少人在用",删除前也要靠它判断。 */
export interface RoleWithUserCount {
  role: Role;
  userCount: number;
}

export interface RoleListFilter extends PageParams {
  /** 同时匹配 code 与 name。 */
  keyword?: string | undefined;
}

export interface RoleRepository {
  /** code 唯一由数据库约束保证,实现需把 P2002 翻译成 conflict。 */
  create(role: Role): Promise<void>;

  findById(id: string): Promise<Role | null>;

  /** 按角色码查找(唯一索引)。seed 幂等写入时用。 */
  findByCode(code: string): Promise<Role | null>;

  /** 分页列表,按 builtin 倒序 + createdAt 正序 —— 内置角色永远排在最前面。 */
  list(filter: RoleListFilter): Promise<Page<RoleWithUserCount>>;

  /** 全部角色,不分页。用于用户编辑页的角色多选框 —— 角色数量业务上就是有限的。 */
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
