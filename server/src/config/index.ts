/**
 * 应用配置 —— 全项目唯一读 process.env 的地方。
 *
 * 干什么: 用 zod 解析并校验全部环境变量,启动时 fail-fast,导出类型化的 config 对象。
 * 解决什么问题:
 * - 姊妹项目有 **37 处裸读 process.env 散在 16 个文件**里,没有集中校验。
 *   实锤后果:同一个端口在 ports.json 写 42421、main.ts 默认值 42421、
 *   .env 与 .env.example 写 41421、origin-guard 兜底 42421 —— 四处记载三个值。
 * - 配置错误必须在**启动时**炸,而不是等到某个冷门代码路径第一次执行才发现。
 *   会静默产生一个 Invalid Date 的过期时间,所有会话立刻失效且没人知道为什么。
 *
 * eslint R4 规则禁止其他文件裸读 process.env,强制走这里。
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
// 纯函数,零 IO —— 只读 os.networkInterfaces()。与启动横幅列地址用的是同一份实现,
// 避免"白名单放行的 IP"和"打印出来让人访问的 IP"两边算法漂移。
import { lanIPv4 } from '../infrastructure/system/access-urls.js';

/**
 * 仓库根。所有相对路径(数据库、静态资源、.env)都以它为基准。
 *
 * [坑] **不能**用 import.meta.url 往上数几层算出来 —— 源码在
 * server/src/config/(往上四层)、打包产物在 server/dist/(往上两层),
 * 层数不一样。按源码层数写死的话,dev 全绿、生产启动时找不到 .env 直接崩,
 * 是典型的"只炸生产"问题。
 *
 * 改用「从当前文件位置向上找第一个有 pnpm-workspace.yaml 的目录」——
 * 两种形态都能正确定位,也不依赖 cwd(容器里 cwd 可能是任意目录)。
 * 找不到时退回 cwd。
 */
const findRepoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
};

export const REPO_ROOT = findRepoRoot();

/**
 * 加载 .env。
 *
 * [优先级] 真实环境变量 > .env 文件 > 代码里的默认值。
 * Node 的 loadEnvFile **不会覆盖**已存在的 process.env 条目,所以这个顺序天然成立 ——
 * 容器/CI 里注入的环境变量永远赢过仓库里的 .env 文件,不会出现
 * "生产上明明设了变量却被 .env 盖掉"这种事故。
 *
 * 用 Node 原生 API 而不是 dotenv:少一个依赖,行为也更可预期。
 */
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // .env 不存在是正常情况(容器/CI 用真实环境变量),静默走默认值。
}

/**
 * 把任意写法的 contextPath 归一成 '' 或 '/xxx'(前有斜杠、后无斜杠)。
 *
 * 为什么要归一: contextPath 的坑几乎全来自「同一个值有多种写法」——
 * `''` / `'/'` / `'/app'` / `'/app/'` 语义相同但字符串不同,
 * 各处消费点各自 if 一遍就必然有人漏判,症状是路径多一道或少一道斜杠,
 * 而且只在启用 contextPath 时才炸。归一成一种形态,消费点直接用不再自己拼。
 *
 * [同步] `scripts/ports.mjs` 里有一份等价实现(给 vite 和开发脚本用,
 * 那边在 workspace 之外没法 import 本文件)。改这里要同步改那边,
 * 两边的一致性由 config.test.ts 用同一组样例守着。
 */
export const normalizeContextPath = (raw: string | undefined | null): string => {
  if (raw === undefined || raw === null) return '';
  const trimmed = String(raw).trim();
  if (trimmed === '' || trimmed === '/') return '';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, '');
};

/**
 * 端口的兜底默认值。
 *
 * 真源是 `.env`(见 .env.example)。这里的值只在**既没有 .env 也没有环境变量**
 * 时才会被用到 —— 比如容器里只 COPY 了 dist 却忘了给 PORT。
 *
 * [同步] `scripts/ports.mjs` 的 DEFAULTS 必须与此完全一致(那份给 vite 和开发
 * 脚本用,两个运行时读不到对方的代码)。`config/ports-default.test.ts` 守着,
 * 改一处不改另一处会红。
 *
 * 曾经这里读的是根目录的 ports.json,号称"端口单一真源",实测是个错觉:
 * 读它 5 处、绕过它硬编码 6 处,反而让人以为改一处就够了。详见 ports.mjs 头注释。
 */
const DEFAULT_SERVER_PORT = 7101;
const DEFAULT_WEB_PORT = 7102;

const ConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),

  port: z.coerce.number().int().min(1).max(65535).default(DEFAULT_SERVER_PORT),
  /**
   * 绑定地址。默认 0.0.0.0 监听全部网卡,局域网内其他设备可直接访问 ——
   * 开发时用手机试移动端、给同事演示都不用改配置。
   * 服务本身是有鉴权的(未登录一律 401),但仍建议只在可信网络里这么开;
   * 只想本机访问就设 HOST=127.0.0.1。
   */
  host: z.string().default('0.0.0.0'),

  /**
   * 前端 dev server 端口。后端自己不监听它,但开发态要靠它拼出 vite 的 origin
   * 加进 CSRF 白名单(见下方 devOrigins)。生产用不到。
   */
  webPort: z.coerce.number().int().min(1).max(65535).default(DEFAULT_WEB_PORT),

  /** 相对路径以仓库根为基准,与根目录 prisma.config.ts 的约定一致。 */
  databaseUrl: z.string().default('file:./data/app.db'),

  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * JSONL 日志文件路径(相对仓库根)。
   *
   * 留空 = 不落盘,只输出 stdout —— 容器/K8s 部署时用这个,
   * 日志由平台采集,在容器里写文件反而是反模式(除非挂了卷)。
   * 本机 / 物理机 / pm2 部署保留默认,方便直接 grep 排查。
   */
  logFile: z.string().default('logs/app.jsonl'),

  /** 保留多少个轮转文件。按天轮转,约等于保留多少天。 */
  logRetainFiles: z.coerce.number().int().min(1).max(365).default(14),

  /**
   * 单文件大小上限。当天日志超过它会再切一个,防止某天狂刷日志出一个巨型文件。
   * 留空则只按天切。
   */
  logMaxFileSize: z.string().default('50m'),

  /**
   * JWT 签名密钥。至少 32 字节,不够长启动直接崩(见 hs256-token-signer.ts)。
   *
   * [重要] 换掉它会让**所有已签发的令牌立即失效**,全员重新登录 ——
   * 这也是唯一的"强制全员下线"手段:JWT 是自验证的,无法单独吊销某一个令牌。
   *
   * 不设时开发态自动生成随机密钥并打警告(进程一重启大家就得重登,只适合本机开发);
   * 生产不设则**拒绝启动** —— 多实例部署时各实例密钥不同,登录到 A 的令牌在 B 上
   * 验不过,表现为"随机掉登录",极难定位。
   */
  jwtSecret: z.string().optional(),

  /**
   * 令牌有效期(秒)。默认 7 天。
   *
   * 它同时决定两件事,调它就是在两者之间取舍:
   *   - 用户多久要重新登录一次
   *   - 改权限 / 禁用账号后多久真正生效 —— 权限固化在令牌载荷里,要等过期才刷新
   * 要权限变更更快生效就调短,代价是登录更频繁。
   */
  jwtTtlSeconds: z.coerce.number().int().min(60).default(7 * 24 * 60 * 60),

  /**
   * 是否强制密码加密传输。
   *
   * 默认 false: 同时接受明文与密文,方便 curl 冒烟脚本和运维脚本。
   * 有安全测评要求(等保「口令加密传输」)的环境设成 true,
   * 后端会拒绝一切明文密码登录。
   *
   * [注意] 这一项与 HTTPS 是两回事 —— 传输安全始终由 TLS 负责,
   * 加密只是避免密码出现在 DevTools / nginx body 日志 / APM 抓包里。
   */
  requireEncryptedPassword: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  /** 请求体大小上限(字节)。防一个大 JSON 打爆内存。 */
  bodyLimitBytes: z.coerce.number().int().min(1024).default(1024 * 1024),

  /** 登录限流:同一 用户名+IP 在窗口内允许的失败次数。 */
  loginRateLimit: z.coerce.number().int().min(1).default(5),
  loginRateWindowMs: z.coerce.number().int().min(1000).default(60_000),

  /**
   * 额外允许的跨源(逗号分隔)。
   *
   * 生产是单端口同源部署,通常不需要配。
   * 开发态的 vite dev server 会自动加进白名单(见下方 buildConfig),
   * 所以这个变量只在"前端部署在另一个域名"这种非常规场景才需要设。
   */
  allowedOrigins: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== ''),
    ),

  /** 生产模式下托管前端静态文件的目录。不设即纯 API 模式(开发态)。 */
  serveWebDir: z.string().optional(),

  /**
   * 应用上下文根。从 CONTEXT_PATH 读,不设即挂根。
   * 归一化后同时提供 contextPrefix / contextBase / apiPrefix 三种形态。
   */
  contextPath: z.string().optional(),
});

export type AppConfig = z.output<typeof ConfigSchema> & {
  isProduction: boolean;
  isTest: boolean;
  /** 数据库文件的绝对路径,由 databaseUrl 解析而来。 */
  dbPath: string;
  webPort: number;
  /** 已解析的 JWT 密钥。未配置时是进程内随机生成的(仅开发态)。 */
  jwtSecret: string;
  /** 归一化后的上下文根:'' 或 '/app'(前有斜杠、后无斜杠)。拼路径用。 */
  contextPrefix: string;
  /** 归一化后的基路径:'/' 或 '/app/'(带尾斜杠)。浏览器可点地址用。 */
  contextBase: string;
  /** API 完整前缀:'/api' 或 '/app/api'。前端 baseURL 与后端挂载点共用同一个值。 */
  apiPrefix: string;
};

const buildConfig = (): AppConfig => {
  const parsed = ConfigSchema.safeParse({
    nodeEnv: process.env['NODE_ENV'],
    port: process.env['PORT'],
    host: process.env['HOST'],
    webPort: process.env['WEB_PORT'],
    databaseUrl: process.env['DATABASE_URL'],
    logLevel: process.env['LOG_LEVEL'],
    logFile: process.env['LOG_FILE'],
    logRetainFiles: process.env['LOG_RETAIN_FILES'],
    logMaxFileSize: process.env['LOG_MAX_FILE_SIZE'],
    jwtSecret: process.env['JWT_SECRET'],
    jwtTtlSeconds: process.env['JWT_TTL_SECONDS'],
    requireEncryptedPassword: process.env['AUTH_REQUIRE_ENCRYPTED_PASSWORD'],
    bodyLimitBytes: process.env['BODY_LIMIT_BYTES'],
    loginRateLimit: process.env['LOGIN_RATE_LIMIT'],
    loginRateWindowMs: process.env['LOGIN_RATE_WINDOW_MS'],
    allowedOrigins: process.env['ALLOWED_ORIGINS'],
    serveWebDir: process.env['SERVE_WEB'],
    contextPath: process.env['CONTEXT_PATH'],
  });

  if (!parsed.success) {
    // 直接写 stderr 而不是用 logger —— 此刻 logger 还没建起来(它依赖 config)。
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    process.stderr.write(`[FATAL] 环境变量配置错误,启动中止:\n${issues}\n`);
    process.exit(1);
  }

  const value = parsed.data;


  const rawPath = value.databaseUrl.startsWith('file:')
    ? value.databaseUrl.slice('file:'.length)
    : value.databaseUrl;

  const isProduction = value.nodeEnv === 'production';

  /**
   * 开发态自动放行 vite dev server。
   *
   * 为什么必须有: 开发时前端在 :7002,请求经 vite proxy 转到后端 :7001。
   * 浏览器发的 Origin 是 http://localhost:7002,而后端收到的 Host 是 127.0.0.1:7001 ——
   * origin-guard 的"同源即放行"判定不成立,所有 POST 会被拒成 403。
   * (实测踩到:登录页报"请求来源不被信任"。)
   *
   * localhost 与 127.0.0.1 都要放行:两者在浏览器眼里是不同的源,
   * 而开发者可能用任意一个访问。
   *
   * **本机网卡 IP 同样要放行**。vite dev server 监听全部网卡(见 vite.config.ts),
   * 同事或手机用 http://192.168.x.x:7002 打开页面时,浏览器发的 Origin 就是那个 IP,
   * 而 proxy 的 changeOrigin 把 Host 换成了 127.0.0.1:7001 —— 同源判定不成立,
   * 白名单里又没有这个 IP,于是登录被拒成 403。
   * 症状极具迷惑性: 页面能打开、curl 直连后端也能通,唯独浏览器里登不进去。
   * (后端日志里会有一行 `拒绝跨源写请求`,带上 origin 和 host,那是唯一的线索。)
   *
   * 生产**不加**这些 —— 那是真实的跨源放行,不该出现在产线配置里。
   */
  const devOrigins = isProduction
    ? []
    : [
        `http://localhost:${value.webPort}`,
        `http://127.0.0.1:${value.webPort}`,
        ...lanIPv4().map((ip) => `http://${ip}:${value.webPort}`),
      ];

  // 环境变量优先于 ports.json —— 容器里没有 ports.json,只能靠 CONTEXT_PATH 注入
  const contextPrefix = normalizeContextPath(value.contextPath);

  /*
   * JWT 密钥兜底。
   *
   * 开发态没设就随机生成 —— 直接崩会让 `pnpm dev` 开箱即用失效,新人第一次跑就撞墙。
   * 代价是进程重启密钥就变、已签发的令牌全部失效,所以要打一行醒目警告。
   *
   * 生产态则**拒绝启动**:多实例各自随机会导致「登录到 A 的令牌在 B 上验不过」,
   * 表现为随机掉登录,是最难查的一类问题。
   */
  const rawSecret = value.jwtSecret ?? '';
  if (rawSecret === '') {
    if (isProduction) {
      process.stderr.write(
        '[FATAL] 生产环境必须设置 JWT_SECRET(至少 32 字节)。\n' +
          '        生成一个: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"\n',
      );
      process.exit(1);
    }
    process.stderr.write(
      '[WARN] 未设置 JWT_SECRET,已生成临时密钥 —— 进程重启后所有人需要重新登录。\n' +
        '       正式使用请写进 .env。\n',
    );
  }

  return {
    ...value,
    jwtSecret: rawSecret === '' ? randomBytes(48).toString('base64url') : rawSecret,
    allowedOrigins: [...new Set([...value.allowedOrigins, ...devOrigins])],
    isProduction,
    isTest: value.nodeEnv === 'test',
    dbPath: resolve(REPO_ROOT, rawPath),
    webPort: value.webPort,
    contextPrefix,
    contextBase: contextPrefix === '' ? '/' : `${contextPrefix}/`,
    apiPrefix: `${contextPrefix}/api`,
  };
};

export const config: AppConfig = buildConfig();
