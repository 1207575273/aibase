/**
 * Prisma 7 CLI 配置 —— generate / migrate / studio 都读这里。
 *
 * 干什么: 声明 schema 与 migrations 位置,并把 DATABASE_URL 交给 CLI。
 *
 * 解决什么问题:
 * - Prisma 7 起 CLI 不再隐式读 .env,用 Node 原生 process.loadEnvFile() 显式加载
 *   (免引 dotenv)。
 * - 迁移用的连接串与运行时用的必须是**同一个** —— 都来自 DATABASE_URL。
 *   两侧各读各的会导致"迁移跑在 A 库、应用连着 B 库",症状是"迁移明明成功了但表不存在"。
 *
 * [SQLite 时代的遗留已清理] 以前这里有一大段把 file: 相对路径归一成绝对路径的逻辑,
 * 还要和运行时的 resolveDbPath 保持一致。换成 PostgreSQL 之后连接串就是连接串,
 * 没有"相对谁"的问题,这类坑整体消失。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

// 本文件固定在仓库根,以文件位置为基准而不是 CLI 的 cwd —— 测试夹具可能从子目录调 CLI。
const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // .env 不存在是正常情况(CI / 容器用真实环境变量),静默跳过。
}

/*
 * 缺失时给一个**故意无效**的占位串,而不是抛异常。
 *
 * [坑] 一开始这里是"没设就 throw"。看着更严格,实际上直接卡死了镜像构建 ——
 * `prisma generate` 只是照着 schema 生成代码,根本不连数据库,却因为
 * 配置文件在模块顶层抛异常而失败。构建机上本来就不该有数据库连接串。
 *
 * 占位串让 generate 正常工作,而真正要连库的命令(migrate / studio)会失败在
 * 连接这一步 —— 报错里带着 DATABASE_URL_NOT_SET 这个显眼的主机名,
 * 一眼就知道是没配而不是连不上。
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://DATABASE_URL_NOT_SET:5432/unset';

export default defineConfig({
  schema: resolve(REPO_ROOT, 'server/prisma/schema.prisma'),
  migrations: {
    path: resolve(REPO_ROOT, 'server/prisma/migrations'),
    // migrate reset / migrate dev 建库后自动灌种子,保证「重置完就能登录」。
    seed: 'tsx server/prisma/seed.ts',
  },
  datasource: {
    url: databaseUrl,
  },
});
