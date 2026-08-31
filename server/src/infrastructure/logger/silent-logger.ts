/**
 * 静默 Logger —— 什么都不做。
 *
 * 干什么: 给测试用。
 * 解决什么问题:
 *   1. 业务日志会把测试输出淹没,真正的断言失败信息反而找不到
 *   2. 测试**不该往 logs/ 里写文件** —— 跑一次测试留一堆日志文件是污染
 *   3. pino 的文件输出跑在 worker thread 里,每个测试文件都开一个
 *      会明显拖慢测试,而且退出时还要等 flush
 *
 * 需要断言"有没有打日志"的测试,自己写一个记录到数组的假件即可 ——
 * Logger 是个只有五个方法的接口,不值得在这里做一个通用的可断言实现。
 */

import type { LogMeta, Logger } from '../../domain/shared/logger.js';

const noop = (): void => undefined;

export const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: (_bindings: LogMeta): Logger => silentLogger,
};
