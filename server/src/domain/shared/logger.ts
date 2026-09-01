/**
 * 日志端口。
 *
 * 干什么: 让业务代码能打日志,而不关心它最终是彩色文本还是 JSON。
 * 解决什么问题:
 * - 曾见过的一个项目里,200 个 application 文件中只有 2 个引用了 logger —— 一次业务写操作
 *   在日志里完全无痕,线上出问题只能靠猜。本模板要求**所有写操作至少打一行**。
 * - child() 是关键: 中间件用它派生出带 traceId 的子 logger 注入下去,
 *   于是一次请求产生的所有日志行都自带同一个 traceId,可以直接串起来看。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 结构化日志的附加字段。会被序列化,所以不要塞进大对象或循环引用。 */
export type LogMeta = Record<string, unknown>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /** 派生一个带固定字段的子 logger,典型用法是 child({ traceId })。 */
  child(bindings: LogMeta): Logger;
}
