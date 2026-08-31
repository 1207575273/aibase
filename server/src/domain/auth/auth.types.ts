/**
 * 认证域实体类型 —— User / Role / Session。
 *
 * 都是 interface 而不是 class: 实体没有行为(行为在 Service),
 * 用 interface 意味着从数据库读出来的普通对象直接就是实体,不需要构造一层包装。
 */

import type { DataScope } from './actor.js';

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

/**
 * 会话 —— 不透明 token 的服务端载荷。
 *
 * [安全] 库里只存 token 的 sha256,明文只在签发那一刻存在于响应里。
 * 库被拖走也无法从 hash 反推出可用的 token。
 */
export interface Session {
  id: string;
  /** sha256(明文 token) 的 hex。唯一索引,是每请求的查找路径。 */
  tokenHash: string;
  userId: string;
  /** 滑动过期时间。用户每次活跃往后推,但不能越过 absoluteExpiresAt。 */
  expiresAt: Date;
  /** 绝对上限。无论多活跃,超过就必须重新登录 —— 防止会话永生。 */
  absoluteExpiresAt: Date;
  /** 上次活跃时间。用于节流续期写库(见 authenticate.service.ts)。 */
  lastSeenAt: Date;
  createdAt: Date;
  /** 仅用于"我的登录设备"展示,截断到 200 字符。 */
  userAgent: string | null;
  ip: string | null;
}

/**
 * 按 tokenHash 一次查出来的完整主体信息。
 *
 * 为什么把它定义成一个专门的类型而不是让 Service 查三次:
 * 这是**每个请求都要走的热路径**,必须一次 join 拿完 session + user + roles。
 * Repository 实现用 Prisma 的 include 完成,Service 拿到的就是这个扁平结构。
 */
export interface SessionPrincipal {
  session: Session;
  user: User;
  roles: Array<{
    code: string;
    superAdmin: boolean;
    dataScope: DataScope;
    permissions: string[];
  }>;
}
