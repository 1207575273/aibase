/**
 * 仓储所接受的数据库客户端类型。
 *
 * 干什么: 让同一个仓储类既能拿完整的 PrismaClient,也能拿事务客户端。
 * 解决什么问题: Prisma 的 $transaction 回调给的是 `Prisma.TransactionClient`
 *   (完整 client 去掉 $transaction / $connect / $on 等顶层方法)。
 *   如果仓储构造函数写死要 PrismaClient,就没法在事务里复用同一套仓储 ——
 *   要么每个仓储写两遍,要么在 UnitOfWork 里做不安全的类型断言。
 *
 * TransactionClient 是**更窄**的类型,所以 PrismaClient 天然可以赋值给它。
 * 仓储统一收这个类型即可,两种场景都覆盖。
 *
 * [代价] 仓储里不能再用 `this.db.$transaction([...])`(事务客户端没有这个方法)。
 *   列表查询要"findMany 与 count 同快照"时,改用 Prisma 的批量读写法或接受
 *   两次独立查询 —— 见 person.repository.ts 里的说明。
 */
import type { Prisma } from './prisma.js';

export type DbClient = Prisma.TransactionClient;
