/**
 * UnitOfWork 的 Prisma 实现。
 *
 * 干什么: 开一个数据库事务,把「绑定在这个事务上的一整套仓储」交给回调。
 * 解决什么问题: 让 application 层能声明跨聚合的事务边界,
 *   而不必把业务级联规则塞进某个仓储的 delete 方法里(姊妹项目的做法)。
 *
 * 实现要点:
 *   Prisma 的 $transaction(fn) 会给回调一个事务客户端(Prisma.TransactionClient)。
 *   仓储的构造函数统一收 DbClient(就是这个类型),所以事务客户端可以直接传进去 ——
 *   **不需要任何类型断言**,回调里所有写操作自动走同一个事务。
 */

import type { RepoBundle, UnitOfWork } from '../../../domain/shared/unit-of-work.js';
import type { DbClient } from './db-client.js';
import type { PrismaClient } from './prisma.js';
import { PrismaRoleRepository } from './role.repository.js';
import { PrismaSessionRepository } from './session.repository.js';
import { PrismaUserRepository } from './user.repository.js';

/**
 * 用给定的客户端组装一整套仓储。
 *
 * 参数既可以是完整的 PrismaClient(普通场景),也可以是事务客户端(UnitOfWork 里),
 * 因为 PrismaClient 本身就可以赋值给更窄的 DbClient。
 */
export const buildRepos = (db: DbClient): RepoBundle => ({
  user: new PrismaUserRepository(db),
  role: new PrismaRoleRepository(db),
  session: new PrismaSessionRepository(db),
});

export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  async run<T>(fn: (repos: RepoBundle) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => fn(buildRepos(tx)));
  }
}
