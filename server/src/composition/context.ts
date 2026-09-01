/**
 * 应用上下文 —— 所有模块共用的基础设施。
 *
 * 干什么: 建数据库连接、logger、时钟、id 生成器、事务器,打成一个包传给各模块。
 * 解决什么问题: 模块装配函数只需要一个参数,加一样基础设施不用改所有模块的签名。
 */

import { config, REPO_ROOT } from '../config/index.js';
import { systemClock, type Clock } from '../domain/shared/clock.js';
import type { IdGenerator } from '../domain/shared/id-generator.js';
import type { Logger } from '../domain/shared/logger.js';
import type { UnitOfWork } from '../domain/shared/unit-of-work.js';
import { uuidGenerator } from '../infrastructure/ids/uuid-generator.js';
import { createLogger } from '../infrastructure/logger/pino-logger.js';
import { createPrismaClient } from '../infrastructure/persistence/postgres/prisma-client.js';
import type { PrismaClient } from '../infrastructure/persistence/postgres/prisma.js';
import { PrismaUnitOfWork } from '../infrastructure/persistence/postgres/unit-of-work.js';

export interface AppContext {
  prisma: PrismaClient;
  uow: UnitOfWork;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
  /**
   * 冲刷并关闭日志。**优雅关闭时必须调用** ——
   * pino 把写盘放在 worker thread,不 flush 的话缓冲区里的日志会跟着进程一起消失,
   * 而那几条往往正是崩溃原因。
   */
  closeLogger: () => Promise<void>;
}

export interface CreateContextOptions {
  /** 覆盖数据库连接串。测试用 —— 生产走 config。 */
  connectionString?: string;
  /** 覆盖 logger。测试里可以传一个静默实现,免得测试输出被日志刷屏。 */
  logger?: Logger;
  clock?: Clock;
  ids?: IdGenerator;
}

export const createContext = async (options: CreateContextOptions = {}): Promise<AppContext> => {
  // 测试传了自己的 logger 就不建 pino —— 免得每个测试文件都往 logs/ 里写东西,
  // 也免得开一堆 worker thread 拖慢测试
  const handle =
    options.logger !== undefined
      ? { logger: options.logger, close: async (): Promise<void> => undefined }
      : createLogger({
          level: config.logLevel,
          // 生产输出 JSON 供日志系统采集,开发输出带颜色的文本供人读
          json: config.isProduction,
          // 文件里**始终**是 JSONL,与 stdout 的格式无关 —— 排查问题要的是可分析,不是好看
          file: config.logFile,
          repoRoot: REPO_ROOT,
          retainFiles: config.logRetainFiles,
          maxFileSize: config.logMaxFileSize,
        });

  const prisma = await createPrismaClient({
    connectionString: options.connectionString ?? config.databaseUrl,
    verbose: !config.isProduction,
  });

  return {
    prisma,
    uow: new PrismaUnitOfWork(prisma),
    logger: handle.logger,
    clock: options.clock ?? systemClock,
    ids: options.ids ?? uuidGenerator,
    closeLogger: handle.close,
  };
};
