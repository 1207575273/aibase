/**
 * 用户仓储的 Prisma 实现。
 */

import type { Page } from '../../../domain/shared/page.js';
import type {
  UserListFilter,
  UserRepository,
  UserWithRoles,
} from '../../../domain/auth/user.repository.js';
import type { User, UserStatus } from '../../../domain/auth/auth.types.js';
import type { DataScope, RoleGrant } from '../../../domain/auth/actor.js';
import { AUTH_ERROR } from '../../../domain/auth/auth.errors.js';
import { conflict } from '../../../domain/shared/app-error.js';
import { mapPrismaError } from './prisma-error.js';
import type { PrismaClient, PrismaTypes } from './prisma.js';
import type { DbClient } from './db-client.js';
import { stripUndefined } from './strip-undefined.js';

type UserRow = NonNullable<Awaited<ReturnType<PrismaClient['user']['findUnique']>>>;

/** 带角色关联的行形状。roles 是 join 出来的中间表 + 角色本体。 */
interface UserRowWithRoles extends UserRow {
  roles: Array<{ role: { id: string; code: string; name: string } }>;
}

const USER_WITH_ROLES_INCLUDE = {
  roles: { select: { role: { select: { id: true, code: true, name: true } } } },
} as const;

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly db: DbClient) {}

  async create(user: User, roleIds: readonly string[]): Promise<void> {
    await mapPrismaError(
      () =>
        this.db.user.create({
          data: {
            ...toRow(user),
            // 嵌套写:用户与角色绑定在同一条语句里完成,天然原子。
            // 这正是恢复 @relation 换来的能力 —— 姊妹项目禁用外键后
            // 这里得手写两次 insert 再自己包事务。
            roles: { create: roleIds.map((roleId) => ({ roleId })) },
          },
        }),
      {
        unique: {
          username: () => conflict(AUTH_ERROR.USERNAME_TAKEN, `用户名 ${user.username} 已存在`),
        },
      },
    );
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.db.user.findUnique({ where: { id } });
    return row === null ? null : toEntity(row);
  }

  async findByUsername(username: string): Promise<User | null> {
    const row = await this.db.user.findUnique({ where: { username } });
    return row === null ? null : toEntity(row);
  }

  async findRoleGrants(userId: string): Promise<RoleGrant[]> {
    // 单次查询带出 role + permissions 两层。登录时走一次,不在热路径上,
    // 但仍然不拆成先查角色再逐个查权限 —— 那是 N+1。
    const rows = await this.db.userRole.findMany({
      where: { userId },
      include: { role: { include: { permissions: { select: { code: true } } } } },
    });

    return rows.map((r) => ({
      code: r.role.code,
      superAdmin: r.role.superAdmin,
      dataScope: r.role.dataScope as DataScope,
      permissions: r.role.permissions.map((p) => p.code),
    }));
  }

  async findWithRoles(id: string): Promise<UserWithRoles | null> {
    const row = await this.db.user.findUnique({
      where: { id },
      include: USER_WITH_ROLES_INCLUDE,
    });
    return row === null ? null : toEntityWithRoles(row);
  }

  async list(filter: UserListFilter): Promise<Page<UserWithRoles>> {
    const where = buildWhere(filter);
    // 两次独立查询,不包同一快照 —— 理由见 person.repository.ts 的同位置说明。
    const [rows, total] = await Promise.all([
      this.db.user.findMany({
        where,
        include: USER_WITH_ROLES_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      this.db.user.count({ where }),
    ]);
    return { items: rows.map(toEntityWithRoles), total };
  }

  async update(
    id: string,
    patch: Partial<
      Pick<User, 'displayName' | 'status' | 'passwordHash' | 'updatedAt' | 'updatedBy'>
    >,
  ): Promise<void> {
    await mapPrismaError(() =>
      this.db.user.update({ where: { id }, data: stripUndefined(patch) }),
    );
  }

  async replaceRoles(userId: string, roleIds: readonly string[]): Promise<void> {
    // 先删后插。deleteMany + createMany 两条语句,由调用方的事务保证原子性 ——
    // Service 里改角色一定是包在 uow.run 里的。
    await this.db.userRole.deleteMany({ where: { userId } });
    if (roleIds.length > 0) {
      await this.db.userRole.createMany({
        data: roleIds.map((roleId) => ({ userId, roleId })),
      });
    }
  }

  async delete(id: string): Promise<void> {
    // user_role 与 session 由外键 onDelete: Cascade 自动清理,这里不需要手工断链。
    await mapPrismaError(() => this.db.user.delete({ where: { id } }));
  }

  async countByRoleId(roleId: string): Promise<number> {
    return this.db.userRole.count({ where: { roleId } });
  }
}

const buildWhere = (filter: UserListFilter): PrismaTypes.UserWhereInput => {
  const where: PrismaTypes.UserWhereInput = {};
  if (filter.keyword !== undefined && filter.keyword !== '') {
    where.OR = [
      { username: { contains: filter.keyword } },
      { displayName: { contains: filter.keyword } },
    ];
  }
  if (filter.status !== undefined) where.status = filter.status;
  return where;
};

const toEntity = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  displayName: row.displayName,
  passwordHash: row.passwordHash,
  status: row.status as UserStatus,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  createdBy: row.createdBy,
  updatedBy: row.updatedBy,
});

const toEntityWithRoles = (row: UserRowWithRoles): UserWithRoles => ({
  user: toEntity(row),
  roles: row.roles.map((r) => r.role),
});

const toRow = (u: User): UserRow => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  passwordHash: u.passwordHash,
  status: u.status,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
  createdBy: u.createdBy,
  updatedBy: u.updatedBy,
});
