/**
 * 认证服务 —— 登录、登出、鉴别身份、改密。
 *
 * 干什么: 承载「你是谁」这条线的全部业务规则。
 *
 * ── Service 粒度约定(新模块照抄这个形状)────────────────────────
 *
 * 默认一个聚合一个 Service,CRUD 就是它的几个方法。
 * 满足下列任一条件时,把那个动作单独拆成 `<动作>.usecase.ts`,由 Service 委托调用:
 *   1. 方法体超过约 80 行
 *   2. 这个动作要注入 Service 其他方法都用不上的依赖(如导入 Excel 需要 FileParser)
 *   3. 它是跨聚合编排,且有独立的事务边界
 * 拆出去之后对外仍是 Service 一个入口,路由层不用改。
 *
 * 依赖一律走构造函数注入一个 deps 对象:加依赖不破坏已有调用点,
 * 测试里写字面量即可,不需要 DI 容器,也不需要 vi.mock。
 */

import { randomBytes } from 'node:crypto';
import {
  hasPermission,
  mergeRoles,
  type ActorContext,
  type DataScope,
} from '../../domain/auth/actor.js';
import { AUTH_ERROR } from '../../domain/auth/auth.errors.js';
import type { Session, SessionPrincipal } from '../../domain/auth/auth.types.js';
import type { LoginChallenge, LoginCrypto } from '../../domain/auth/login-crypto.js';
import type { PasswordHasher } from '../../domain/auth/password-hasher.js';
import type { SessionRepository } from '../../domain/auth/session.repository.js';
import type { TokenGenerator } from '../../domain/auth/token-generator.js';
import type { UserRepository } from '../../domain/auth/user.repository.js';
import { forbidden, invalid, unauthenticated } from '../../domain/shared/app-error.js';
import type { Clock } from '../../domain/shared/clock.js';
import type { IdGenerator } from '../../domain/shared/id-generator.js';
import type { Logger } from '../../domain/shared/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 续期写库的节流间隔。
 *
 * 不节流的话每个请求都要写一次事务 —— SQLite 单写者模型下这会成为全站唯一的
 * 全局写热点,业务写操作都得排在它后面。5 分钟粒度对 7 天的滑动窗口完全够用。
 */
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;

export interface AuthServiceDeps {
  userRepo: UserRepository;
  sessionRepo: SessionRepository;
  hasher: PasswordHasher;
  tokens: TokenGenerator;
  loginCrypto: LoginCrypto;
  ids: IdGenerator;
  clock: Clock;
  logger: Logger;
  slidingDays: number;
  absoluteDays: number;
  /** true 时拒绝明文密码通道,只接受加密传输(用于有安全测评要求的环境)。 */
  requireEncryptedPassword: boolean;
}

export interface LoginInput {
  username: string;
  /** 明文密码。与 passwordCipher 二选一。 */
  password?: string | undefined;
  /** 混合加密后的密码。浏览器走这条。 */
  passwordCipher?: string | undefined;
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
}

/** 认证结果:主体 + 会话 id(改密时要用它来"保留当前设备")。 */
export interface AuthenticateResult {
  actor: ActorContext;
  sessionId: string;
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /**
   * 登录。
   *
   * [安全] 用户不存在与密码错误必须**不可区分**:同一个错误码、同一句文案、
   * 以及**相近的耗时**。耗时这一点靠 dummy verify 实现 —— 用户不存在时仍然跑一次
   * 哈希验证。否则"用户不存在"是 1ms、"密码错"是 150ms,时序直接暴露了
   * 这个用户名是否注册过,等于提供了一个用户名枚举接口。
   */
  async login(input: LoginInput): Promise<LoginResult> {
    const password = await this.resolvePassword(input);
    const user = await this.deps.userRepo.findByUsername(input.username);

    if (user === null) {
      await this.burnTime(password);
      throw unauthenticated('用户名或密码错误', AUTH_ERROR.INVALID_CREDENTIALS);
    }

    const verified = await this.deps.hasher.verify(password, user.passwordHash);
    if (!verified.ok) {
      throw unauthenticated('用户名或密码错误', AUTH_ERROR.INVALID_CREDENTIALS);
    }

    // 禁用判定放在密码校验**之后**:先验密码才提示"账号被禁用",
    // 否则不知道密码的人也能探出"这个账号存在但被禁用了"。
    if (user.status === 'DISABLED') {
      throw forbidden('账号已被禁用,请联系管理员', { code: AUTH_ERROR.USER_DISABLED });
    }

    // 算法或成本参数过时 -> 用当前参数重新哈希落库,用户无感升级。
    // 这就是"将来换 argon2id 不需要强制全员重置密码"的机制。
    if (verified.needsRehash) {
      const now = this.deps.clock();
      const fresh = await this.deps.hasher.hash(password);
      await this.deps.userRepo.update(user.id, {
        passwordHash: fresh,
        updatedAt: now,
        updatedBy: user.id,
      });
      this.deps.logger.info('密码哈希已升级到当前参数', { userId: user.id });
    }

    const session = await this.issueSession(user.id, input.userAgent, input.ip);
    this.deps.logger.info('登录成功', { userId: user.id, username: user.username });

    return { token: session.raw, expiresAt: session.expiresAt };
  }

  /**
   * 鉴别身份 —— 每个受保护请求都会调用。
   *
   * 步骤: 查会话 -> 判过期 -> 判用户状态 -> 合并角色权限 -> 滑动续期。
   */
  async authenticate(rawToken: string, traceId: string): Promise<AuthenticateResult> {
    const tokenHash = this.deps.tokens.hashOf(rawToken);
    const principal = await this.deps.sessionRepo.findPrincipalByTokenHash(tokenHash);

    // 刻意不区分"token 不存在"与"token 已被删除" —— 不给攻击者任何枚举线索。
    if (principal === null) throw unauthenticated();

    const now = this.deps.clock();
    const { session, user } = principal;

    if (now >= session.expiresAt || now >= session.absoluteExpiresAt) {
      // 顺手清掉,不留垃圾。定时任务是兜底,这里是即时清理。
      await this.deps.sessionRepo.deleteByTokenHash(tokenHash);
      throw unauthenticated('登录已过期,请重新登录', AUTH_ERROR.TOKEN_EXPIRED);
    }

    if (user.status === 'DISABLED') {
      // 用户被禁用时把他所有会话一起清掉,而不只是当前这个 ——
      // 否则他换个已登录的设备还能继续用。
      await this.deps.sessionRepo.deleteAllByUserId(user.id);
      throw forbidden('账号已被禁用,请联系管理员', { code: AUTH_ERROR.USER_DISABLED });
    }

    const merged = mergeRoles(principal.roles);
    const actor: ActorContext = {
      actorId: user.id,
      username: user.username,
      ...merged,
      traceId,
    };

    await this.slideExpiry(session, now);
    return { actor, sessionId: session.id };
  }

  /** 登出。幂等 —— 重复调用或 token 已失效都不报错。 */
  async logout(rawToken: string): Promise<void> {
    await this.deps.sessionRepo.deleteByTokenHash(this.deps.tokens.hashOf(rawToken));
  }

  /**
   * 当前用户信息。给前端渲染菜单、按钮权限用。
   *
   * 直接从 actor 拼装,不再查库 —— actor 就是刚刚从库里算出来的,
   * 再查一次纯属浪费。
   */
  async me(actor: ActorContext): Promise<SessionPrincipal['user'] & { roles: string[] }> {
    const user = await this.deps.userRepo.findById(actor.actorId);
    if (user === null) throw unauthenticated();
    return { ...user, roles: [...actor.roleCodes] };
  }

  /**
   * 修改自己的密码。
   *
   * 成功后踢掉本人**其他**设备的会话(保留当前设备)——
   * 改密码的常见动机就是"怀疑账号被盗",不踢掉其他会话等于没改。
   */
  async changePassword(
    input: { oldPassword: string; newPassword: string },
    actor: ActorContext,
    sessionId: string,
  ): Promise<void> {
    const user = await this.deps.userRepo.findById(actor.actorId);
    if (user === null) throw unauthenticated();

    const verified = await this.deps.hasher.verify(input.oldPassword, user.passwordHash);
    if (!verified.ok) {
      throw invalid(AUTH_ERROR.OLD_PASSWORD_MISMATCH, '原密码不正确');
    }
    if (input.oldPassword === input.newPassword) {
      throw invalid('AUTH_PASSWORD_UNCHANGED', '新密码不能与原密码相同');
    }

    const now = this.deps.clock();
    const passwordHash = await this.deps.hasher.hash(input.newPassword);
    await this.deps.userRepo.update(user.id, {
      passwordHash,
      updatedAt: now,
      updatedBy: actor.actorId,
    });
    await this.deps.sessionRepo.deleteOthersByUserId(user.id, sessionId);

    this.deps.logger.info('用户修改了密码', { userId: user.id });
  }

  /** 权限判定的公开入口,供 interface 层的 requirePermission 中间件调用。 */
  can(actor: ActorContext, code: string): boolean {
    return hasPermission(actor, code);
  }

  /**
   * 签发登录挑战(公钥 + 一次性 nonce)。
   * 前端在提交登录表单前先取一次,用它加密密码。
   */
  issueLoginChallenge(): LoginChallenge {
    return this.deps.loginCrypto.issueChallenge();
  }

  // ── 私有 ──────────────────────────────────────────────────────

  /**
   * 解析出明文密码 —— 两条通道二选一。
   *
   * 契约层(zod refine)已经保证了"有且只有一个",这里的兜底是防御性的:
   * Service 可能被 HTTP 之外的入口调用(定时任务、CLI),不能假设一定过了 zod。
   */
  private async resolvePassword(input: LoginInput): Promise<string> {
    if (input.passwordCipher !== undefined) {
      return this.deps.loginCrypto.decryptPassword(input.passwordCipher);
    }

    if (input.password === undefined) {
      throw invalid(AUTH_ERROR.INVALID_CREDENTIALS, '缺少密码');
    }

    // 强制加密的环境里明文通道直接拒绝。
    // 注意这个判断在验证密码**之前** —— 不能让明文请求走完整个流程再拒,
    // 那样明文密码已经进了内存和日志上下文。
    if (this.deps.requireEncryptedPassword) {
      this.deps.logger.warn('拒绝明文密码登录', { username: input.username });
      throw invalid(AUTH_ERROR.PLAINTEXT_PASSWORD_REJECTED, '本环境要求密码加密传输');
    }

    return input.password;
  }

  /** 签发会话。 */
  private async issueSession(
    userId: string,
    userAgent: string | undefined,
    ip: string | undefined,
  ): Promise<{ raw: string; expiresAt: Date }> {
    const now = this.deps.clock();
    const { raw, hash } = this.deps.tokens.issue();

    const absoluteExpiresAt = new Date(now.getTime() + this.deps.absoluteDays * DAY_MS);
    const expiresAt = new Date(
      Math.min(now.getTime() + this.deps.slidingDays * DAY_MS, absoluteExpiresAt.getTime()),
    );

    const session: Session = {
      id: this.deps.ids.next(),
      tokenHash: hash,
      userId,
      expiresAt,
      absoluteExpiresAt,
      lastSeenAt: now,
      createdAt: now,
      // 截断:UA 字符串可以很长,而它只用于"我的登录设备"的展示
      userAgent: userAgent?.slice(0, 200) ?? null,
      ip: ip ?? null,
    };

    await this.deps.sessionRepo.create(session);
    return { raw, expiresAt };
  }

  /**
   * 滑动续期,带写库节流。
   *
   * 新的过期时间取 min(now + 滑动窗口, 绝对上限) —— 滑动永远不能越过绝对上限,
   * 否则一个天天使用的账号会话就永生了。
   */
  private async slideExpiry(session: Session, now: Date): Promise<void> {
    if (now.getTime() - session.lastSeenAt.getTime() < TOUCH_THROTTLE_MS) return;

    const next = new Date(
      Math.min(now.getTime() + this.deps.slidingDays * DAY_MS, session.absoluteExpiresAt.getTime()),
    );
    await this.deps.sessionRepo.touch(session.id, now, next);
  }

  /**
   * 消耗与真实验证相当的时间,抹平"用户不存在"与"密码错误"的耗时差。
   *
   * 每次现算一个 dummy 哈希而不是用模块级常量:常量会在进程启动时就固定,
   * 而这里每次都走完整的 hash 流程,耗时特征与真实路径最接近。
   * 代价是多一次 64MiB 的哈希 —— 所以登录限流是必需品(见 login-rate-limit 中间件)。
   */
  private async burnTime(password: string): Promise<void> {
    const dummy = await this.deps.hasher.hash(randomBytes(16).toString('hex'));
    await this.deps.hasher.verify(password, dummy);
  }
}

/** 让 domain 的 DataScope 类型在 application 层可见,避免路由层再从 domain 深处 import。 */
export type { DataScope, LoginChallenge };
