/**
 * 会话仓储的 Prisma 实现。
 *
 * [性能] findPrincipalByTokenHash 是**全站最热的查询** —— 每个受保护请求走一次。
 * 它必须是单次 join 拿完四层数据(session -> user -> userRole -> role -> rolePermission),
 * 绝不能查完 session 再查 user 再查 roles。
 */

import type { SessionRepository } from '../../../domain/auth/session.repository.js';
import type { Session, SessionPrincipal, UserStatus } from '../../../domain/auth/auth.types.js';
import type { DataScope } from '../../../domain/auth/actor.js';
import type { PrismaClient } from './prisma.js';
import type { DbClient } from './db-client.js';

type SessionRow = NonNullable<Awaited<ReturnType<PrismaClient['session']['findUnique']>>>;

export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly db: DbClient) {}

  async create(session: Session): Promise<void> {
    await this.db.session.create({ data: toRow(session) });
  }

  async findPrincipalByTokenHash(tokenHash: string): Promise<SessionPrincipal | null> {
    const row = await this.db.session.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            roles: {
              include: {
                role: { include: { permissions: { select: { code: true } } } },
              },
            },
          },
        },
      },
    });

    if (row === null) return null;

    return {
      session: toEntity(row),
      user: {
        id: row.user.id,
        username: row.user.username,
        displayName: row.user.displayName,
        passwordHash: row.user.passwordHash,
        status: row.user.status as UserStatus,
        createdAt: row.user.createdAt,
        updatedAt: row.user.updatedAt,
        createdBy: row.user.createdBy,
        updatedBy: row.user.updatedBy,
      },
      roles: row.user.roles.map((ur) => ({
        code: ur.role.code,
        superAdmin: ur.role.superAdmin,
        dataScope: ur.role.dataScope as DataScope,
        permissions: ur.role.permissions.map((p) => p.code),
      })),
    };
  }

  async touch(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void> {
    await this.db.session.update({ where: { id }, data: { lastSeenAt, expiresAt } });
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    // deleteMany 而不是 delete:不存在时不抛 P2025,登出天然幂等。
    await this.db.session.deleteMany({ where: { tokenHash } });
  }

  async deleteAllByUserId(userId: string): Promise<void> {
    await this.db.session.deleteMany({ where: { userId } });
  }

  async deleteOthersByUserId(userId: string, keepSessionId: string): Promise<void> {
    await this.db.session.deleteMany({
      where: { userId, id: { not: keepSessionId } },
    });
  }

  async deleteExpired(now: Date): Promise<number> {
    // 两个条件取或:滑动过期或绝对过期,任一命中就该清掉。
    const result = await this.db.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { absoluteExpiresAt: { lt: now } }] },
    });
    return result.count;
  }
}

const toEntity = (row: SessionRow): Session => ({
  id: row.id,
  tokenHash: row.tokenHash,
  userId: row.userId,
  expiresAt: row.expiresAt,
  absoluteExpiresAt: row.absoluteExpiresAt,
  lastSeenAt: row.lastSeenAt,
  createdAt: row.createdAt,
  userAgent: row.userAgent,
  ip: row.ip,
});

const toRow = (s: Session): SessionRow => ({
  id: s.id,
  tokenHash: s.tokenHash,
  userId: s.userId,
  expiresAt: s.expiresAt,
  absoluteExpiresAt: s.absoluteExpiresAt,
  lastSeenAt: s.lastSeenAt,
  createdAt: s.createdAt,
  userAgent: s.userAgent,
  ip: s.ip,
});
