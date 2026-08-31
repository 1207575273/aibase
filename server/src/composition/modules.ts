/**
 * 模块装配 —— 把仓储、Service、路由依赖组装起来。
 *
 * 干什么: 每个业务模块一个 buildXxxModule(ctx) 函数,返回它的路由依赖。
 *
 * 解决什么问题:
 *   姊妹项目 work_nm_tp 的 main.ts 有 **1173 行**(300 行 import + 665 行连续的 new),
 *   一个函数里塞了 12 个域的装配。它自定的"装配 >200 行才考虑拆"的触发条件
 *   用了个 AND 把自己豁免掉了,实际早已 5 倍超标。
 *
 *   更直接的代价是**测试**: 它的 tasks.routes.test.ts 开头 import 了 24 个 UseCase,
 *   只为在 beforeEach 里把装配逻辑重抄一遍。装配改一次,要同步改 N 个测试文件。
 *
 *   拆成 buildXxxModule 之后,main.ts 和测试**调用的是同一个函数**,装配只有一份真相。
 *   加一个业务模块也不需要动 main.ts。
 */

import { AuthService } from '../application/auth/auth.service.js';
import { RoleService } from '../application/role/role.service.js';
import { UserService } from '../application/user/user.service.js';
import { config } from '../config/index.js';
import { buildRepos } from '../infrastructure/persistence/sqlite/unit-of-work.js';
import { ScryptPasswordHasher } from '../infrastructure/security/scrypt-password-hasher.js';
import { CryptoTokenGenerator } from '../infrastructure/security/crypto-token-generator.js';
import { RsaLoginCrypto } from '../infrastructure/security/rsa-login-crypto.js';
import type { AppDeps } from '../interface/http/app.js';
import type { AppContext } from './context.js';

/**
 * 组装全部模块,产出 buildApp 需要的依赖。
 *
 * 新增业务模块时改这里的两处:建 Service、填进返回值。
 */
export const buildModules = async (
  ctx: AppContext,
): Promise<Omit<AppDeps, 'version' | 'startedAt'>> => {
  const repos = buildRepos(ctx.prisma);
  const hasher = new ScryptPasswordHasher();
  const tokens = new CryptoTokenGenerator();

  // RSA 密钥在进程内存里生成,不落盘 —— 没有密钥文件可泄漏,且天然随重启轮换。
  // 生成是异步的,所以 buildModules 是 async。
  const loginCrypto = new RsaLoginCrypto({ clock: ctx.clock });
  await loginCrypto.init();

  const authService = new AuthService({
    userRepo: repos.user,
    sessionRepo: repos.session,
    hasher,
    tokens,
    loginCrypto,
    requireEncryptedPassword: config.requireEncryptedPassword,
    ids: ctx.ids,
    clock: ctx.clock,
    logger: ctx.logger.child({ module: 'auth' }),
    slidingDays: config.sessionSlidingDays,
    absoluteDays: config.sessionAbsoluteDays,
  });

  const userService = new UserService({
    userRepo: repos.user,
    roleRepo: repos.role,
    hasher,
    uow: ctx.uow,
    ids: ctx.ids,
    clock: ctx.clock,
    logger: ctx.logger.child({ module: 'user' }),
  });

  const roleService = new RoleService({
    roleRepo: repos.role,
    userRepo: repos.user,
    ids: ctx.ids,
    clock: ctx.clock,
    logger: ctx.logger.child({ module: 'role' }),
  });


  return {
    auth: {
      service: authService,
      cookieName: config.sessionCookieName,
      // 按请求实际协议判断,不按 NODE_ENV —— 内网 HTTP 部署时后者会给明文连接
      // 发带 Secure 的 Cookie,浏览器静默丢弃,表现为登录 200 后立刻 401
      secureCookie: config.cookieSecure,
      // Cookie 作用域跟随上下文根,避免同域多应用之间互相看到 / 互相挤下线
      cookiePath: config.contextBase,
    },
    user: { service: userService },
    role: { service: roleService },
    logger: ctx.logger,
    // 健康检查的真探活。用 $queryRaw 而不是 count() ——
    // SELECT 1 不碰任何表,库结构变了也不会影响健康检查。
    pingDb: async (): Promise<boolean> => {
      try {
        await ctx.prisma.$queryRawUnsafe('SELECT 1');
        return true;
      } catch (e) {
        ctx.logger.error('数据库探活失败', { err: e });
        return false;
      }
    },
    allowedOrigins: config.allowedOrigins,
    bodyLimitBytes: config.bodyLimitBytes,
    loginRateLimit: {
      limit: config.loginRateLimit,
      windowMs: config.loginRateWindowMs,
      clock: ctx.clock,
    },
    clock: ctx.clock,
  };
};

/** 会话清理任务:定期删掉过期会话,防止 sys_session 无限增长。 */
export const startSessionCleanup = (ctx: AppContext): (() => void) => {
  const repos = buildRepos(ctx.prisma);

  const sweep = (): void => {
    void repos.session
      .deleteExpired(ctx.clock())
      .then((count) => {
        if (count > 0) ctx.logger.info('清理过期会话', { count });
      })
      .catch((e: unknown) => ctx.logger.error('清理过期会话失败', { err: e }));
  };

  sweep(); // 启动时先跑一次
  const timer = setInterval(sweep, 60 * 60 * 1000);
  // unref: 这个定时器不应该阻止进程退出
  timer.unref();

  return () => clearInterval(timer);
};
