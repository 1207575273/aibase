/**
 * 优雅关闭 + 进程级异常兜底。
 *
 * 解决什么问题:
 * - 姊妹项目的 shutdown **从不调用 server.close()**(grep 零命中),
 *   收到 SIGTERM 后直接 process.exit —— 在途请求被当场掐断,
 *   用户看到的是"连接被重置"。容器滚动更新时每次都会有一批请求失败。
 * - 它也**零处** unhandledRejection / uncaughtException 监听。
 *   一个没 catch 的 Promise 会让 Node 直接崩掉,而日志里什么都没有。
 *
 * 关闭顺序(有意义,不要调整):
 *   1. server.close()  停止接受新连接,但等待在途请求处理完
 *   2. 等待(带超时)     卡死的请求不能无限拖着不退出
 *   3. 清理定时器等资源
 *   4. prisma.$disconnect()  最后才断数据库,保证在途请求还能用
 */

import type { Logger } from '../domain/shared/logger.js';

export interface ShutdownOptions {
  logger: Logger;
  /** 关闭 HTTP 服务器,resolve 表示在途请求已处理完。 */
  closeServer: () => Promise<void>;
  /** 释放其他资源(定时器、数据库连接等)。 */
  cleanup: () => Promise<void>;
  /** 等待在途请求的最长时间,超时就强退。 */
  timeoutMs?: number;
}

export const registerShutdown = (options: ShutdownOptions): void => {
  const { logger, closeServer, cleanup, timeoutMs = 10_000 } = options;

  // 幂等标记: 连按两次 Ctrl+C 或容器同时发多个信号时,不要重复执行关闭流程
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn('已在关闭中,忽略重复信号', { signal });
      return;
    }
    shuttingDown = true;
    logger.info('开始优雅关闭', { signal });

    try {
      // Promise.race:正常关完就走,卡死了也要在超时后强退 ——
      // 否则一个挂起的长请求会让容器一直停不下来,最后被 SIGKILL 粗暴杀掉。
      await Promise.race([
        closeServer(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            logger.warn('等待在途请求超时,强制关闭', { timeoutMs });
            resolve();
          }, timeoutMs),
        ),
      ]);

      await cleanup();
      logger.info('关闭完成');
      process.exit(0);
    } catch (e) {
      logger.error('关闭过程出错', { err: e });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 兜底:没有这两个监听时,一个漏 catch 的 Promise 会让进程静默崩溃。
  // 打完日志后仍然退出 —— 进程状态已经不可信,继续跑只会产生更难解释的错误。
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise rejection', { err: reason });
    void shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (err) => {
    logger.error('未捕获异常', { err });
    void shutdown('uncaughtException');
  });
};
