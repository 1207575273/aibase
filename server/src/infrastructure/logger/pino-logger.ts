/**
 * Logger 实现 —— pino + pino-roll,支持 JSONL 落盘与按天轮转。
 *
 * 干什么: 同时输出到 stdout(容器/终端看)与 JSONL 文件(排查问题时 grep 分析)。
 *
 * ── 为什么用 pino 而不是自己写 ────────────────────────────────
 *
 * 写 JSONL 本身很简单(appendFile 就行),难的是两件事:
 *
 * 1. **轮转**。按天切分、超大小切分、清理旧文件、并发写不串行化 ——
 *    手写约 150 行,而且错了不会立刻暴露(表现是几个月后磁盘写满,
 *    或者某段日志静默丢失)。pino-roll 是 pino 官方生态里做这件事的。
 *
 * 2. **不阻塞事件循环**。appendFileSync 每行都阻塞,请求量一上来就是真问题。
 *    pino 把序列化和写盘放到 worker thread,主线程只往共享内存丢字节。
 *
 * ── 为什么脱敏不用 pino 内置的 redact ─────────────────────────
 *
 * pino 的 redact 是**路径匹配**,要提前声明每一条路径。
 * 实测它漏掉 `deep.deeper.password` —— 而敏感字段出现在第几层是无法预知的
 * (比如有人 `logger.error('失败', { input })`,input 里嵌着 user 对象)。
 * 所以脱敏仍走我们自己的递归实现(见 redact.ts),pino 只负责写。
 *
 * ── 关闭时必须 flush ─────────────────────────────────────────
 *
 * worker thread 意味着进程退出时可能还有日志在缓冲区里。
 * 优雅关闭**必须调用返回的 close()**,否则最后几条(往往正是崩溃原因)会丢。
 */

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';
import type { LogLevel, LogMeta, Logger } from '../../domain/shared/logger.js';
import { sanitize } from './redact.js';

export interface PinoLoggerOptions {
  level: LogLevel;
  /** stdout 输出 JSON(生产/容器)还是彩色文本(开发)。 */
  json: boolean;
  /**
   * JSONL 文件路径。留空则不落盘(容器部署时交给平台采集 stdout)。
   * 相对路径以 repoRoot 为基准。
   */
  file?: string | undefined;
  repoRoot: string;
  /** 保留多少个轮转文件。按天轮转时约等于保留多少天。 */
  retainFiles: number;
  /** 单文件大小上限,如 '50m'。超过会在当天内再切一个。 */
  maxFileSize?: string | undefined;
}

/** 与 domain 的 LogLevel 对齐 —— pino 的级别名恰好一致,不需要映射表。 */
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 };

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

/**
 * 开发态的人类可读输出。
 *
 * 不用 pino-pretty:那是第三个依赖 + 第二个 worker thread,
 * 而我们要的排版只有这十几行。
 */
const prettyStream = (): DestinationStream => ({
  write(line: string): void {
    try {
      const o = JSON.parse(line) as Record<string, unknown> & {
        level: number;
        time: number;
        msg: string;
      };
      const level = (Object.keys(LEVEL_ORDER) as LogLevel[]).find(
        (l) => LEVEL_ORDER[l] === o.level,
      );
      const color = COLORS[level ?? 'info'];
      const time = new Date(o.time).toISOString().slice(11, 23);

      // 结构化字段拼在消息后面。pid/hostname 这些开发时没人看,去掉
      const rest = Object.entries(o)
        .filter(([k]) => !['level', 'time', 'msg', 'pid', 'hostname'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');

      const head = `${color}${(level ?? 'info').toUpperCase().padEnd(5)}${RESET}`;
      process.stdout.write(`${time} ${head} ${o.msg}${rest === '' ? '' : ` ${rest}`}\n`);
    } catch {
      // 解析不了就原样输出,总比吞掉强
      process.stdout.write(line);
    }
  },
});

/** 包一层,把 domain 的 Logger 接口映射到 pino,并在入口做脱敏。 */
class PinoLoggerAdapter implements Logger {
  constructor(private readonly inner: PinoLogger) {}

  private write(level: LogLevel, message: string, meta?: LogMeta): void {
    // 先判级别再脱敏 —— debug 日志在 info 级别下根本不该付出遍历成本
    if (!this.inner.isLevelEnabled(level)) return;
    this.inner[level](meta === undefined ? {} : (sanitize(meta) as object), message);
  }

  debug(message: string, meta?: LogMeta): void {
    this.write('debug', message, meta);
  }
  info(message: string, meta?: LogMeta): void {
    this.write('info', message, meta);
  }
  warn(message: string, meta?: LogMeta): void {
    this.write('warn', message, meta);
  }
  error(message: string, meta?: LogMeta): void {
    this.write('error', message, meta);
  }

  child(bindings: LogMeta): Logger {
    return new PinoLoggerAdapter(this.inner.child(sanitize(bindings) as object));
  }
}

export interface LoggerHandle {
  logger: Logger;
  /**
   * 冲刷缓冲区并关闭 worker。**优雅关闭时必须调用** ——
   * 否则最后几条日志(往往正是崩溃原因)会留在缓冲区里跟着进程一起消失。
   */
  close: () => Promise<void>;
}

export const createLogger = (options: PinoLoggerOptions): LoggerHandle => {
  const { level, json, file, repoRoot, retainFiles, maxFileSize } = options;

  /**
   * 文件输出走 pino-roll(worker thread)。
   * stdout 走主线程直写 —— 它本来就快,再开一个 worker 不值得,
   * 而且开发态的彩色排版必须在主线程做。
   */
  const fileTransport =
    file === undefined || file === ''
      ? undefined
      : (() => {
          const filePath = isAbsolute(file) ? file : resolve(repoRoot, file);
          // pino-roll 的 mkdir 只建最后一级,父目录不存在照样失败,这里先兜底
          mkdirSync(dirname(filePath), { recursive: true });

          return pino.transport({
            target: 'pino-roll',
            options: {
              /**
               * pino-roll 会在文件名与扩展名之间插入日期和序号:
               *   logs/app.jsonl  ->  logs/app.2026-08-27.1.jsonl
               *
               * [坑] **扩展名要留在 file 里**,不要剥掉再用 extension 选项传 ——
               * README 写明 `extension` 只在"文件名本身不含扩展名时"才生效,
               * 所以剥掉之后反而会落到它的默认值 `.log`。
               * (第一版就是这么写的,结果生成的是 app.2026-08-27.1.log。)
               */
              file: filePath,
              frequency: 'daily',
              dateFormat: 'yyyy-MM-dd',
              mkdir: true,
              // count 是**额外保留**的文件数:count=14 实际留 14 个历史 + 1 个当前
              limit: { count: retainFiles },
              ...(maxFileSize !== undefined && maxFileSize !== ''
                ? { size: maxFileSize }
                : {}),
            },
          });
        })();

  // stdout:生产输出 JSON 供采集,开发输出彩色文本供人读。
  // 文件里**始终**是 JSONL —— 排查问题要的是可分析,不是好看。
  const stdout: DestinationStream = json ? pino.destination({ dest: 1 }) : prettyStream();

  const streams = [
    { level, stream: stdout },
    ...(fileTransport !== undefined ? [{ level, stream: fileTransport }] : []),
  ];

  const inner: PinoLogger = pino({ level }, pino.multistream(streams));

  return {
    logger: new PinoLoggerAdapter(inner),
    close: async (): Promise<void> => {
      if (fileTransport === undefined) return;
      await new Promise<void>((done) => {
        // 冲刷设上限,避免关闭流程被卡住 —— 宁可丢最后一点日志,不能卡住不退出
        const timer = setTimeout(done, 2000);
        fileTransport.on('close', () => {
          clearTimeout(timer);
          done();
        });
        fileTransport.end();
      });
    },
  };
};
