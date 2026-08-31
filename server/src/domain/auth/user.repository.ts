/**
 * 用户仓储端口。
 *
 * 干什么: 抽象 User 的持久化,Service 通过它工作,不感知 Prisma。
 *
 * [约定] 每个方法的 JSDoc 必须写明**实现必须满足的查询语义** ——
 *   过滤条件、排序、是否含关联。这样内存假件和 Prisma 实现有同一份可对照口径,
 *   比裸接口签名有用得多:签名只说"返回 User[]",注释才说清"按什么排、含不含已禁用"。
 */

import type { Page, PageParams } from '../shared/page.js';
import type { User, UserStatus } from './auth.types.js';

/** 用户及其角色。列表与详情都要展示角色,所以做成一个带关联的读取形状。 */
export interface UserWithRoles {
  user: User;
  roles: Array<{ id: string; code: string; name: string }>;
}

export interface UserListFilter extends PageParams {
  /** 同时匹配 username 与 displayName,大小写不敏感。空/未传则不过滤。 */
  keyword?: string | undefined;
  status?: UserStatus | undefined;
}

export interface UserRepository {
  /**
   * 创建用户并绑定角色,必须在同一事务内完成。
   * 用户名唯一性**由数据库唯一约束保证**,实现需把 P2002 翻译成 conflict ——
   * 不要在 Service 里"先查后写",那是 check-then-act 竞态。
   */
  create(user: User, roleIds: readonly string[]): Promise<void>;

  /** 未命中返回 null,不抛异常。 */
  findById(id: string): Promise<User | null>;

  /** 按用户名精确查找(唯一索引)。登录用。未命中返回 null。 */
  findByUsername(username: string): Promise<User | null>;

  /** 带角色的详情。未命中返回 null。 */
  findWithRoles(id: string): Promise<UserWithRoles | null>;

  /**
   * 分页列表,按 createdAt 倒序(新建的排前面)。
   * roleIds 为空数组的用户也要返回,不能因为 join 不到角色就漏掉。
   */
  list(filter: UserListFilter): Promise<Page<UserWithRoles>>;

  /**
   * 更新基本字段。只更新传入的字段,undefined 表示不改。
   * updatedAt / updatedBy 由调用方(Service)从 Clock 取值后显式传入,
   * 实现里**不要**自己写 new Date()。
   */
  update(
    id: string,
    patch: Partial<Pick<User, 'displayName' | 'status' | 'passwordHash' | 'updatedAt' | 'updatedBy'>>,
  ): Promise<void>;

  /** 全量替换角色绑定(先删后插)。空数组表示清空角色。 */
  replaceRoles(userId: string, roleIds: readonly string[]): Promise<void>;

  /**
   * 硬删除。关联的 user_role / session 由数据库外键 onDelete: Cascade 自动清理。
   * (本模板恢复了 DB 外键 —— 姊妹项目全库禁用外键后每个 delete 都要人肉断链,
   *  忘了就是悬空引用且 SQLite 不报错。)
   */
  delete(id: string): Promise<void>;

  /** 统计持有指定角色的用户数。删角色前的 ROLE_IN_USE 判断用。 */
  countByRoleId(roleId: string): Promise<number>;
}
