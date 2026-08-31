/**
 * Prisma 7 CLI 配置 —— generate / migrate / studio 都读这里。
 *
 * 干什么: 声明 schema 与 migrations 位置,并把 DATABASE_URL 归一化成绝对路径 file: URL。
 * 解决什么问题:
 * - Prisma 7 起 CLI 不再隐式读 .env,用 Node 原生 process.loadEnvFile() 显式加载(免引 dotenv);
 * - file: 相对路径的解析基准在 v6/v7 各场景下并不一致,统一策略是「DATABASE_URL 按仓库根相对
 *   书写,两侧各自 resolve 成绝对路径」—— 运行时侧的同一套逻辑在
 *   server/src/infrastructure/persistence/sqlite/prisma-client.ts,两边必须保持一致。
 * - better-sqlite3 adapter 解析 url 是「裸剥 file: 前缀」而不是 URL parser,
 *   所以必须给 'file:' + 绝对路径,不能用 file:/// 三斜杠形态(Windows 下会报目录不存在)。
 */
import { isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

// 本文件固定在仓库根,以文件位置为基准而不是 CLI 的 cwd —— 测试夹具可能从子目录调 CLI。
const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // .env 不存在是正常情况(CI / 容器用真实环境变量),静默走默认值。
}

const rawUrl = process.env.DATABASE_URL ?? 'file:./data/app.db';
const rawPath = rawUrl.startsWith('file:') ? rawUrl.slice('file:'.length) : rawUrl;
const absPath = isAbsolute(rawPath) ? rawPath : resolve(REPO_ROOT, rawPath);

export default defineConfig({
  schema: resolve(REPO_ROOT, 'server/prisma/schema.prisma'),
  migrations: {
    path: resolve(REPO_ROOT, 'server/prisma/migrations'),
    // migrate reset / migrate dev 建库后自动灌种子,保证「重置完就能登录」。
    seed: 'tsx server/prisma/seed.ts',
  },
  datasource: {
    url: `file:${absPath}`,
  },
});
