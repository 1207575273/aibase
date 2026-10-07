/**
 * 角色仓储的 Prisma 实现。
 */

import type { Page } from '../../../lib/page.js';
import type {
  RoleListFilter,
  RoleRepository,
  RoleWithUserCount,
} from '../domain/role.repository.js';
import type { Role } from '../domain/auth.types.js';
import type { DataScope } from '../../../lib/actor.js';
import { AUTH_ERROR } from '../domain/auth.errors.js';
import { conflict } from '../../../lib/app-error.js';
import { mapPrismaError } from '../../../platform/db/prisma-error.js';
import type { PrismaClient, PrismaTypes } from '../../../platform/db/prisma.js';
import type { DbClient } from '../../../platform/db/db-client.js';
import { stripUndefined } from '../../../platform/db/strip-undefined.js';

type RoleRow = NonNullable<Awaited<ReturnType<PrismaClient['role']['findUnique']>>>;

interface RoleRowFull extends RoleRow {
  permissions: Array<{ code: string }>;
  _count?: { users: number };
}

const ROLE_INCLUDE = {
  permissions: { select: { code: true } },
} as const;

export class PrismaRoleRepository implements RoleRepository {
  constructor(private readonly db: DbClient) {}

  async create(role: Role): Promise<void> {
    await mapPrismaError(
      () =>
        this.db.role.create({
          data: {
            ...toRow(role),
            permissions: { create: role.permissions.map((code) => ({ code })) },
          },
        }),
      {
        unique: {
          code: () => conflict(AUTH_ERROR.ROLE_CODE_TAKEN, `角色码 ${role.code} 已存在`),
        },
      },
    );
  }

  async findById(id: string): Promise<Role | null> {
    const row = await this.db.role.findUnique({ where: { id }, include: ROLE_INCLUDE });
    return row === null ? null : toEntity(row);
  }

  async findByIds(ids: readonly string[]): Promise<Role[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.role.findMany({
      where: { id: { in: [...ids] } },
      include: ROLE_INCLUDE,
    });
    return rows.map(toEntity);
  }

  async findByCode(code: string): Promise<Role | null> {
    const row = await this.db.role.findUnique({ where: { code }, include: ROLE_INCLUDE });
    return row === null ? null : toEntity(row);
  }

  async list(filter: RoleListFilter): Promise<Page<RoleWithUserCount>> {
    const where = buildWhere(filter);
    // 两次独立查询,不包同一快照 —— 理由见 user.repository.ts 的 list() 同位置说明。
    const [rows, total] = await Promise.all([
      this.db.role.findMany({
        where,
        include: { ...ROLE_INCLUDE, _count: { select: { users: true } } },
        // 内置角色永远排最前面,再按创建时间正序 —— 管理员打开页面第一眼看到的
        // 应该是 ADMIN 这类关键角色,而不是最近随手建的一个。
        orderBy: [{ builtin: 'desc' }, { createdAt: 'asc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      this.db.role.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({ role: toEntity(r), userCount: r._count.users })),
      total,
    };
  }

  async listAllForPicker(): Promise<Array<Pick<Role, 'id' | 'code' | 'name'>>> {
    // 不分页是有意的:角色数量业务上就是有限的(几个到几十个),
    // 用户编辑页需要一次性拿到全部来渲染多选框。
    return this.db.role.findMany({
      select: { id: true, code: true, name: true },
      orderBy: [{ builtin: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async update(
    id: string,
    patch: Partial<Pick<Role, 'name' | 'description' | 'dataScope' | 'updatedAt' | 'updatedBy'>>,
    permissions?: readonly string[],
  ): Promise<void> {
    await mapPrismaError(() =>
      this.db.role.update({
        where: { id },
        data: {
          ...stripUndefined(patch),
          // permissions 传入时全量替换。undefined 表示"不动权限",
          // 空数组表示"清空权限" —— 两者语义不同,不能合并。
          ...(permissions === undefined
            ? {}
            : {
                permissions: {
                  deleteMany: {},
                  create: permissions.map((code) => ({ code })),
                },
              }),
        },
      }),
    );
  }

  async delete(id: string): Promise<void> {
    // role_permission 由 onDelete: Cascade 清理;
    // user_role 是 onDelete: Restrict —— 仍有人持有时数据库会拒绝,
    // 由 mapPrismaError 翻译成 409(Service 会先 count 给出更友好的报错,
    // 这条是并发下的兜底)。
    await mapPrismaError(() => this.db.role.delete({ where: { id } }), {
      notFound: () => conflict(AUTH_ERROR.ROLE_NOT_FOUND, '角色不存在'),
    });
  }
}

const buildWhere = (filter: RoleListFilter): PrismaTypes.RoleWhereInput => {
  const where: PrismaTypes.RoleWhereInput = {};
  if (filter.keyword !== undefined && filter.keyword !== '') {
    where.OR = [{ code: { contains: filter.keyword } }, { name: { contains: filter.keyword } }];
  }
  // 行级数据权限。findMany 与 count 共用,分页总数同口径。
  if (filter.scopeOwnerId !== undefined) where.createdBy = filter.scopeOwnerId;
  return where;
};

const toEntity = (row: RoleRowFull): Role => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  superAdmin: row.superAdmin,
  builtin: row.builtin,
  dataScope: row.dataScope as DataScope,
  permissions: row.permissions.map((p) => p.code),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  createdBy: row.createdBy,
  updatedBy: row.updatedBy,
});

const toRow = (r: Role): RoleRow => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  superAdmin: r.superAdmin,
  builtin: r.builtin,
  dataScope: r.dataScope,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  createdBy: r.createdBy,
  updatedBy: r.updatedBy,
});
