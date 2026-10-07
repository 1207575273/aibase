/**
 * UnitOfWork 的 Prisma 实现。
 *
 * 干什么: 开一个数据库事务,把「绑定在这个事务上的一整套仓储」交给回调。
 * 解决什么问题: 让 application 层能声明跨聚合的事务边界,
 *   而不必把业务级联规则塞进某个仓储的 delete 方法里(曾见过的一个项目的做法)。
 *
 * 实现要点:
 *   Prisma 的 $transaction(fn) 会给回调一个事务客户端(Prisma.TransactionClient)。
 *   仓储的构造函数统一收 DbClient(就是这个类型),所以事务客户端可以直接传进去 ——
 *   **不需要任何类型断言**,回调里所有写操作自动走同一个事务。
 *
 * 为什么由调用方传入 buildRepos: platform 不能依赖业务模块。
 *   "有哪些仓储"只有 composition 知道(composition/repos.ts),这里只负责开事务。
 */

import type { UnitOfWork } from '../../lib/unit-of-work.js';
import type { DbClient } from './db-client.js';
import type { PrismaClient } from './prisma.js';

export class PrismaUnitOfWork<R> implements UnitOfWork<R> {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly buildRepos: (db: DbClient) => R,
  ) {}

  async run<T>(fn: (repos: R) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => fn(this.buildRepos(tx)));
  }
}
