/**
 * 认证域实体类型 —— User / Role。
 *
 * 都是 interface 而不是 class: 实体没有行为(行为在 Service),
 * 用 interface 意味着从数据库读出来的普通对象直接就是实体,不需要构造一层包装。
 *
 * [历史] 这里曾经还有 Session / SessionPrincipal —— 对应 opaque token + 会话表的
 * 旧方案。改用 JWT 后 sys_session 表已从 schema 删除,这两个类型也一并移除。
 * 留着不删的危害是实打实的: 它们是**活的 TypeScript 类型**(me() 的签名一度还挂在
 * SessionPrincipal 上),typecheck 照样绿,读 domain 的人会以为系统里还有会话表。
 */

import type { DataScope } from '../../../lib/actor.js';

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** 审计字段。所有业务实体都带,是硬约束。 */
export interface AuditFields {
  createdAt: Date;
  updatedAt: Date;
  /** 创建者 userId。seed 建的内置数据为 null。 */
  createdBy: string | null;
  updatedBy: string | null;
}

export interface User extends AuditFields {
  id: string;
  username: string;
  displayName: string;
  /**
   * PHC 风格的哈希串,形如 `$scrypt$N=65536,r=8,p=2$<salt>$<dk>`。
   * [重要] 这个字段绝不能出现在任何 wire 映射里 —— toUserWire 不读它。
   */
  passwordHash: string;
  status: UserStatus;
}

export interface Role extends AuditFields {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** true 时该角色持有者的 hasPermission 恒真。 */
  superAdmin: boolean;
  /** 内置角色:禁止删除、禁止改 code。保证系统永远至少有一个可用的管理员角色。 */
  builtin: boolean;
  dataScope: DataScope;
  /** 权限码快照。真源是代码里的 PERMISSIONS 常量,这里存的是被授予的子集。 */
  permissions: string[];
}

