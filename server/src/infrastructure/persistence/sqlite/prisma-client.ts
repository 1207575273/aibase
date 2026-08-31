/**
 * PrismaClient 工厂 —— 全项目唯一创建数据库连接的地方。
 *
 * 干什么: 解析库路径、装配 better-sqlite3 driver adapter、执行启动 PRAGMA。
 * 解决什么问题: 测试与生产走**完全相同**的建连路径,
 *   不存在"测试库和生产库行为不一样"这一整类问题。
 *   PRAGMA 这种"设了就忘"的配置尤其需要收敛在一处 + 配回归测试。
 *
 * ── Prisma 7 + better-sqlite3 adapter 的几个坑(都已实测)──────────
 *
 * 1. adapter 的 url 解析是**裸剥 'file:' 前缀**,不是 URL parser。
 *    必须传 'file:' + 绝对路径;file:/// 三斜杠形态在 Windows 下会报目录不存在。
 *
 * 2. adapter **单连接终身持有,无连接池** —— 所以连接级 PRAGMA 设一次就全程有效,
 *    不会像连接池那样"事务后换了个新连接,PRAGMA 静默回落"。
 *    (姊妹项目实测过 libsql adapter 有这个回落问题,故排除。)
 *
 * 3. **timestampFormat 必须显式钉死**。adapter 默认把 DateTime 写成 ISO TEXT。
 *    SQLite 是弱类型的,跨类型比较时 INTEGER 恒小于 TEXT —— 一旦库里两种格式混存,
 *    时间范围查询会**静默丢数据**、排序错乱,而且不报任何错。
 *    这里锁 'unixepoch-ms'(整数毫秒),同时保证 raw SQL 里
 *    `datetime(createdAt / 1000, 'unixepoch')` 这类写法成立。
 *
 * 4. adapter 对底层 Database 开了 defaultSafeIntegers: `$queryRaw` 的整数列
 *    返回 **BigInt** 而不是 number(模型 API 不受影响)。写 raw 查询时记得 Number() 转换。
 */

import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { PrismaClient } from './prisma.js';

/**
 * 把 DATABASE_URL 归一化成绝对路径。
 *
 * 约定: 相对路径以**仓库根**为基准。这与根目录 prisma.config.ts 里的逻辑
 * 必须保持一致 —— 两侧任何一边改了基准,CLI 建的库和运行时连的库就会是两个文件,
 * 症状是"迁移跑了但表不存在"。
 */
export const resolveDbPath = (databaseUrl: string, repoRoot: string): string => {
  const raw = databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : databaseUrl;
  return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
};

export interface CreatePrismaClientOptions {
  /** 库文件绝对路径。 */
  dbPath: string;
  /** 开发模式下打印慢查询与警告。 */
  verbose?: boolean;
}

/**
 * 建立数据库连接并强制执行 PRAGMA。
 *
 * [注意] 参数是**显式传入的绝对路径**,不读 process.env。
 * 姊妹项目靠改全局 process.env.DATABASE_URL 给测试传库路径,直接导致
 * vitest 必须串行跑,而且改完从不还原(测试结束后那个全局变量指向一个已被删除的临时目录)。
 * 显式传参让测试可以并行,也让"这个 client 连的是哪个库"在调用点一眼可见。
 */
export const createPrismaClient = async (
  options: CreatePrismaClientOptions,
): Promise<PrismaClient> => {
  const { dbPath, verbose = false } = options;

  // 目录不存在时 SQLite 会直接报错,先建出来。
  // 这里不吞异常:权限不足之类的问题必须让它抛出来,而不是留到连接时报一个更难懂的错。
  mkdirSync(dirname(dbPath), { recursive: true });

  const adapter = new PrismaBetterSqlite3(
    { url: `file:${dbPath}` },
    { timestampFormat: 'unixepoch-ms' },
  );

  const prisma = new PrismaClient({
    adapter,
    log: verbose ? ['warn', 'error'] : ['error'],
  });

  await applyPragmas(prisma);
  return prisma;
};

/**
 * 启动 PRAGMA。顺序有意义:WAL 必须最先设。
 *
 * 注: SQLite 的 PRAGMA 语句通常会**返回当前值**,所以必须用 $queryRawUnsafe
 * 而不是 $executeRawUnsafe —— 后者期待的是"影响行数",拿到结果集会报错。
 */
export const applyPragmas = async (prisma: PrismaClient): Promise<void> => {
  // WAL(Write-Ahead Logging): 读写不互相阻塞,是 SQLite 支撑并发读的关键。
  // [限制] WAL 不能跑在网络文件系统(NFS/SMB)上,只用本地磁盘。
  // [限制] 备份必须把 .db / .db-wal / .db-shm 三个文件一起带走,或者用 VACUUM INTO。
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');

  // NORMAL: 事务提交时不等 fsync 落盘。断电可能丢最后几个事务,但不会损坏数据库。
  // 对业务系统这是标准取舍 —— FULL 的写入吞吐会低一个数量级。
  await prisma.$queryRawUnsafe('PRAGMA synchronous = NORMAL');

  // 写锁被占用时最多等 5 秒再报 SQLITE_BUSY,而不是立刻失败。
  // SQLite 是单写者模型,没有这个的话并发写会直接报错。
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000');

  // [重要] 外键约束默认是**关闭**的,每个连接都要显式打开。
  // 不开的话 schema 里写的 onDelete: Cascade / Restrict 全部不生效,
  // 而且不会有任何报错 —— 悄悄地留下悬空引用。
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON');

  // 临时表和排序中间结果放内存,不落盘。
  await prisma.$queryRawUnsafe('PRAGMA temp_store = MEMORY');
};
