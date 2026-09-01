/**
 * PrismaClient 工厂 —— 全项目唯一创建数据库连接的地方。
 *
 * 干什么: 装配 PostgreSQL driver adapter,产出连好的 PrismaClient。
 * 解决什么问题: 测试与生产走**完全相同**的建连路径,
 *   不存在"测试库和生产库行为不一样"这一整类问题。
 *
 * ── 为什么从 SQLite 换成 PostgreSQL ──────────────────────────────
 *
 * 1. **摆脱单写者模型**。SQLite 全库同时只允许一个写事务,写操作全局排队;
 *    PG 是 MVCC,读不阻塞写、写不阻塞读。原来"事务里绝不能放慢操作"
 *    那条纪律的严重性随之下降(仍然是好习惯,但不再是全站吞吐的生死线)。
 * 2. **去掉原生模块**。better-sqlite3 要 node-gyp 编译,镜像构建阶段得带
 *    python3/make/g++,还会在没有预编译产物的平台上现场编译。
 *    `pg` 是纯 JS,这一整类"某某平台装不上"的问题消失。
 * 3. **可以真正多实例**。SQLite 事实上锁死单进程单机。
 *
 * [不变的取舍] 换库**不会**让镜像变小。@prisma/engines 里的 schema-engine
 *   是一个支持所有数据库的二进制(20MB),CLI 本体 41MB —— 与 provider 无关。
 *   真正让应用镜像瘦下来的是把迁移拆成独立容器(见 deploy/docker-compose.prod.yml)。
 *
 * ── PG 与 SQLite 的行为差异(迁移过来时踩的)────────────────────
 *
 * - **不再需要 PRAGMA**。WAL / foreign_keys / busy_timeout 那一套是 SQLite 专有的。
 *   PG 的外键默认就生效,不存在"忘了开导致级联静默失效"的坑。
 * - **有连接池**。SQLite adapter 是单连接终身持有,PG 是 pg.Pool。
 *   所以"连接级设置设一次就全程有效"的假设不再成立 —— 任何需要会话级状态的
 *   东西都要在每次取连接时设,或者干脆别依赖会话状态。
 * - **时间类型不再有 timestampFormat 的坑**。PG 有真正的 timestamptz,
 *   不像 SQLite 那样弱类型到"整数和字符串混存会静默丢数据"。
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './prisma.js';

export interface CreatePrismaClientOptions {
  /**
   * PostgreSQL 连接串,形如 postgresql://user:pass@host:5432/dbname
   *
   * [注意] 是**显式传入**的,不读 process.env。
   * 曾见过的一个项目靠改全局 process.env.DATABASE_URL 给测试传库地址,直接导致
   * vitest 必须串行跑,而且改完从不还原。显式传参让测试可以并行,
   * 也让"这个 client 连的是哪个库"在调用点一眼可见。
   */
  connectionString: string;
  /** 开发模式下打印警告。 */
  verbose?: boolean;
  /**
   * 连接池上限。默认 10。
   *
   * 单实例业务系统用不到更多 —— 池子开太大只会把压力转嫁给 PG
   * (每个连接在 PG 侧是一个进程)。要扛高并发应该上 pgbouncer,而不是调大这里。
   */
  poolMax?: number;
}

/**
 * 把连接串压成一行可以安全打日志的描述:`host:port/dbname`。
 *
 * [安全] 连接串里带着密码,**绝不能整条进日志**。启动横幅、健康检查、
 * 错误上下文里想说明"连的是哪个库"时一律用这个函数。
 * (logger 的递归脱敏会把 password 这类键名遮掉,但连接串是一整个字符串,
 *  键名脱敏拦不住它 —— 只能在源头就不要把它交出去。)
 *
 * 解析失败时返回一个占位符而不是抛异常: 打印启动信息不该成为启动失败的原因。
 */
export const describeConnection = (connectionString: string): string => {
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\//, '');
    return `${url.hostname}:${url.port || '5432'}/${database}`;
  } catch {
    return '(无法解析的连接串)';
  }
};

export const createPrismaClient = async (
  options: CreatePrismaClientOptions,
): Promise<PrismaClient> => {
  const { connectionString, verbose = false, poolMax = 10 } = options;

  const adapter = new PrismaPg({ connectionString, max: poolMax });

  const prisma = new PrismaClient({
    adapter,
    log: verbose ? ['warn', 'error'] : ['error'],
  });

  return prisma;
};
