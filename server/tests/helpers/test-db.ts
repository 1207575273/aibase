/**
 * 测试用数据库夹具。
 *
 * 干什么: 从 globalSetup 建好的模板库复制一份副本,建连接,返回给测试用;
 *         结束时断开并删除副本。
 * 解决什么问题: 让「单元测试直接连真 SQLite」这件事在成本上可行 ——
 *         复制一个几十 KB 的空库文件是毫秒级操作,而跑一次 prisma CLI 要 ~2 秒。
 *
 * 用法:
 * ```ts
 * const db = await setupTestDb();
 * afterAll(() => db.cleanup());
 * // db.prisma 就是一个连着干净空库的真 PrismaClient
 * ```
 */

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrismaClient } from '../../src/infrastructure/persistence/sqlite/prisma-client.js';
import type { PrismaClient } from '../../src/infrastructure/persistence/sqlite/prisma.js';
import { TEMPLATE_DB_ENV } from './global-setup.js';

export interface TestDb {
  prisma: PrismaClient;
  dbPath: string;
  cleanup: () => Promise<void>;
}

export const setupTestDb = async (): Promise<TestDb> => {
  const templateDb = process.env[TEMPLATE_DB_ENV];
  if (templateDb === undefined) {
    throw new Error(
      `缺少模板库路径(${TEMPLATE_DB_ENV})。检查 vitest.config.ts 是否配了 globalSetup。`,
    );
  }

  // 每个测试自己的临时目录 —— 文件之间零共享,所以测试可以并行跑。
  const dir = mkdtempSync(join(tmpdir(), 'app-test-'));
  const dbPath = join(dir, 'test.db');
  copyFileSync(templateDb, dbPath);

  const prisma = await createPrismaClient({ dbPath });

  return {
    prisma,
    dbPath,
    cleanup: async (): Promise<void> => {
      await prisma.$disconnect();
      // force: 即使 WAL 边车文件已被清掉也不报错
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
