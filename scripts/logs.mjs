/**
 * JSONL 日志查询 —— 排查问题时的常用切片。
 *
 * 干什么: 读 logs/ 下的 JSONL,按条件过滤后打印成人能看的样子。
 * 解决什么问题: JSONL 的价值在于可分析,但每次都现写 `node -e` 或者
 *   跟 jq 的语法搏斗很浪费时间。把最常用的几个切片固化成命令。
 *
 * 用法:
 *   pnpm logs                          最近 50 条
 *   pnpm logs -- --trace <traceId>     串起一次请求的全部日志(最常用)
 *   pnpm logs -- --level error         只看错误
 *   pnpm logs -- --status 500          只看某个状态码(4xx / 5xx 也认)
 *   pnpm logs -- --slow 500            耗时超过 500ms 的请求
 *   pnpm logs -- --grep 关键字          全文搜
 *   pnpm logs -- --actor <userId>      某个用户干了什么
 *   pnpm logs -- --tail 200            改变条数
 *   pnpm logs -- --json                原样输出 JSON(给管道用)
 *   pnpm logs -- --file <路径>          指定文件,默认读最新那个
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = join(ROOT, 'logs');

const LEVEL_NAMES = { 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR' };
const LEVEL_COLORS = { 20: '\x1b[90m', 30: '\x1b[36m', 40: '\x1b[33m', 50: '\x1b[31m' };
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

/** 解析 --key value 形式的参数。 */
const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
};

const args = parseArgs(process.argv.slice(2));

/** 默认读**最新**那个文件 —— 按天轮转下就是今天的。 */
const pickFile = () => {
  if (typeof args.file === 'string') return resolve(ROOT, args.file);
  if (!existsSync(LOG_DIR)) {
    process.stderr.write(
      `[INFO] 还没有日志文件(${LOG_DIR})。\n` +
        '       先跑一次 pnpm dev,或者检查 .env 里的 LOG_FILE 是不是被置空了。\n',
    );
    process.exit(0);
  }
  const files = readdirSync(LOG_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  if (files.length === 0) {
    process.stderr.write(`[INFO] ${LOG_DIR} 下没有 .jsonl 文件\n`);
    process.exit(0);
  }
  return join(LOG_DIR, files[files.length - 1]);
};

const file = pickFile();

const lines = readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      // 单行损坏(比如进程被强杀时写了一半)不该让整个查询失败
      return null;
    }
  })
  .filter((l) => l !== null);

// ── 过滤 ───────────────────────────────────────────────────────

let result = lines;

if (typeof args.trace === 'string') {
  // 支持前缀匹配 —— traceId 很长,用户通常只从报错页面抄前 8 位
  result = result.filter((l) => String(l.traceId ?? '').startsWith(args.trace));
}

if (typeof args.level === 'string') {
  const want = { debug: 20, info: 30, warn: 40, error: 50 }[args.level.toLowerCase()];
  if (want === undefined) {
    process.stderr.write(`[FAIL] 未知级别: ${args.level}(可选 debug/info/warn/error)\n`);
    process.exit(1);
  }
  // 大于等于:--level warn 会同时给出 warn 和 error
  result = result.filter((l) => (l.level ?? 0) >= want);
}

if (typeof args.status === 'string') {
  result =
    args.status.endsWith('xx')
      ? result.filter((l) => Math.floor((l.status ?? 0) / 100) === Number(args.status[0]))
      : result.filter((l) => l.status === Number(args.status));
}

if (typeof args.slow === 'string') {
  const ms = Number(args.slow);
  result = result.filter((l) => (l.durationMs ?? 0) >= ms).sort((a, b) => b.durationMs - a.durationMs);
}

if (typeof args.actor === 'string') {
  result = result.filter((l) => String(l.actorId ?? '').startsWith(args.actor));
}

if (typeof args.grep === 'string') {
  const needle = args.grep.toLowerCase();
  result = result.filter((l) => JSON.stringify(l).toLowerCase().includes(needle));
}

// ── 输出 ───────────────────────────────────────────────────────

// --trace 查的是一次请求的完整过程,必须按时间正序看;其余场景看最近的
const tail = Number(args.tail ?? 50);
const shown = typeof args.trace === 'string' ? result : result.slice(-tail);

if (args.json === true) {
  for (const line of shown) process.stdout.write(`${JSON.stringify(line)}\n`);
} else {
  for (const l of shown) {
    const color = LEVEL_COLORS[l.level] ?? '';
    const level = (LEVEL_NAMES[l.level] ?? '?').padEnd(5);
    const time = new Date(l.time).toISOString().slice(11, 23);

    // 已经单独展示的字段不再重复堆在后面
    const skip = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'traceId']);
    const rest = Object.entries(l)
      .filter(([k]) => !skip.has(k))
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');

    const trace = l.traceId === undefined ? '' : `${DIM}${String(l.traceId).slice(0, 8)}${RESET} `;
    process.stdout.write(`${time} ${color}${level}${RESET} ${trace}${l.msg}${rest ? ` ${rest}` : ''}\n`);
  }
}

process.stderr.write(
  `\n${DIM}${file}  —  匹配 ${result.length} 条,显示 ${shown.length} 条${RESET}\n`,
);
