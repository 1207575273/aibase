/**
 * 端口与上下文根 —— 前端与开发脚本的唯一读取出口。
 *
 * 干什么: 从 `.env` 读端口配置,把 contextPath 归一成一种确定形态。
 *
 * ── 为什么不再用 ports.json ────────────────────────────────────
 *
 * 曾经有一个根目录的 ports.json 充当"端口单一真源"。实测下来它是个错觉:
 * 读它的地方 5 处,而绕过它硬编码端口的地方有 6 处(Dockerfile 三处、
 * compose、config 的兜底常量、e2e 的专用端口)。真正的后果是它让人以为
 * "改一处就够了",于是漏改的地方静默漂移 —— 实锤过两次:
 *   1. Dockerfile 里 PORT=7001 而 ports.json 是 7101,容器起来连不通
 *   2. e2e 的 E2E_PORT 与开发端口撞号,注释还写着"已经错开了"
 *
 * 端口本来就是**环境配置**而不是项目结构,收进 `.env` 之后:
 *   - 少一个文件、少一层"为什么端口不在 .env"的解释
 *   - 后端 config、vite、开发脚本读的是同一份 `.env`,天然同源
 *   - `PORT=8080 pnpm dev` 这种临时覆盖顺理成章(环境变量优先于 .env)
 *
 * ── 默认值的位置 ──────────────────────────────────────────────
 *
 * 本文件的 DEFAULTS 与 server/src/config 的 zod default 是**两处兜底值**,
 * 只在"既没有 .env 也没有环境变量"时才会被用到(真源是 .env.example)。
 * 两者必须相等,由 config/ports-default.test.ts 守着 —— 不靠人记。
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 兜底默认值。改这里必须同步改 server/src/config/index.ts 的 zod default,
 * 有测试守着,不同步会红。
 */
/**
 * 端口兜底默认值。真源是 `.env`,这里只在既没有 .env 也没有环境变量时用到。
 *
 * ── 本项目的端口区段:7101-7109 ─────────────────────────────────
 *   7101  服务入口(开发态是后端,生产态是 nginx —— 同一个号,不用记两套)
 *   7102  前端 dev server
 *   7103  开发数据库(deploy/docker-compose.dev.yml)
 *   7104  测试环境入口(deploy/docker-compose.test.yml)
 *   7105-7109  **预留** —— 以后加 Redis / MQ / 对象存储时从这里取,别随手挑一个
 *   8101  e2e 服务进程,由 `server + 1000` 派生,不单独配
 *
 * [为什么要分段] 一台开发机上同时跑多个项目是常态。不分段就会撞 ——
 * 撞过一次: 开发库本来选的 15432,正好是本机另一个项目的 PG 容器,
 * 症状是"连上了但表都不对",比连不上难查得多。
 * clone 这个模板去做新项目时,把整段换掉(比如 7201-7209)。
 */
export const DEFAULTS = { server: 7101, web: 7102, contextPath: '' };

/**
 * 把任意写法的 contextPath 归一成 '' 或 '/xxx'(前有斜杠、后无斜杠)。
 *
 * '' | '/' | undefined  -> ''
 * 'app' | '/app' | '/app/' -> '/app'
 */
export const normalizeContextPath = (raw) => {
  if (raw === undefined || raw === null) return '';
  const trimmed = String(raw).trim();
  if (trimmed === '' || trimmed === '/') return '';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, '');
};

// 加载 .env。已存在的环境变量不会被覆盖 —— 与后端 config 的优先级一致
// (环境变量 > .env > 默认值),所以 `PORT=8080 pnpm dev` 能正常生效。
const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const toPort = (raw, fallback) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
};

/** 路径前缀,'' 或 '/app'。拼 URL 路径用。 */
export const contextPrefix = normalizeContextPath(
  process.env.CONTEXT_PATH ?? DEFAULTS.contextPath,
);

/** 基路径,'/' 或 '/app/'。vite base、浏览器可点地址用(必须带尾斜杠)。 */
export const contextBase = contextPrefix === '' ? '/' : `${contextPrefix}/`;

export const ports = {
  server: toPort(process.env.PORT, DEFAULTS.server),
  web: toPort(process.env.WEB_PORT, DEFAULTS.web),
  contextPrefix,
  contextBase,
};

/** 后端 API 的完整前缀:'' -> /api,'/app' -> /app/api。 */
export const apiPrefix = `${contextPrefix}/api`;
