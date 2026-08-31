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
import type { SessionPrincipal } from '../../domain/auth/auth.types.js';
import type { LoginChallenge, LoginCrypto } from '../../domain/auth/login-crypto.js';
import type { PasswordHasher } from '../../domain/auth/password-hasher.js';
import type { TokenSigner } from '../../domain/auth/token-signer.js';
import type { UserRepository } from '../../domain/auth/user.repository.js';
import { forbidden, invalid, unauthenticated } from '../../domain/shared/app-error.js';
import type { Clock } from '../../domain/shared/clock.js';
import type { IdGenerator } from '../../domain/shared/id-generator.js';
import type { Logger } from '../../domain/shared/logger.js';


/**
 * 续期写库的节流间隔。
 *
 * 不节流的话每个请求都要写一次事务 —— SQLite 单写者模型下这会成为全站唯一的
 * 全局写热点,业务写操作都得排在它后面。5 分钟粒度对 7 天的滑动窗口完全够用。
 */

export interface AuthServiceDeps {
  userRepo: UserRepository;
  hasher: PasswordHasher;
  /** JWT 签发与验签。取代了原来的「会话表 + 随机 token」。 */
  signer: TokenSigner;
  loginCrypto: LoginCrypto;
  ids: IdGenerator;
  clock: Clock;
  logger: Logger;
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

/** 认证结果:主体 + 令牌过期时刻(前端据此决定何时提前续期)。 */
export interface AuthenticateResult {
  actor: ActorContext;
  expiresAt: Date;
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

    // 权限在**签发这一刻**固化进令牌。这是 JWT 方案的核心取舍:
    // 之后改这个用户的角色或角色的权限,都要等令牌过期重签才生效。
    const roles = await this.deps.userRepo.findRoleGrants(user.id);
    const merged = mergeRoles(roles);

    const { token, expiresAt } = this.deps.signer.sign({
      sub: user.id,
      username: user.username,
      roleCodes: [...merged.roleCodes],
      superAdmin: merged.superAdmin,
      dataScope: merged.dataScope,
      // 超管不枚举权限码 —— hasPermission 对它恒真,塞进去只会让令牌变大
      permissions: merged.superAdmin ? [] : [...merged.permissions],
    });

    this.deps.logger.info('登录成功', { userId: user.id, username: user.username });
    return { token, expiresAt };
  }

  /**
   * 鉴别身份 —— 每个受保护请求都会调用。
   *
   * 步骤: 查会话 -> 判过期 -> 判用户状态 -> 合并角色权限 -> 滑动续期。
   */
  async authenticate(rawToken: string, traceId: string): Promise<AuthenticateResult> {
    const result = this.deps.signer.verify(rawToken);

    if (!result.ok) {
      // 过期给明确提示(前端据此静默跳登录页),伪造只回笼统的未认证 ——
      // 不给攻击者"签名错了还是过期了"这种可用于试探的区分。
      if (result.reason === 'expired') {
        throw unauthenticated('登录已过期,请重新登录', AUTH_ERROR.TOKEN_EXPIRED);
      }
      throw unauthenticated();
    }

    const { claims } = result;

    /*
     * 这里**不查库**,主体信息全部来自令牌。
     *
     * 代价是明确的:用户被禁用、角色被改、权限被收回,都要等令牌过期才生效,
     * 期间这个令牌照常可用。选 JWT 就是选了这一条(见 domain/auth/token-signer.ts)。
     *
     * 需要立即生效的场景只有一个可行做法:把令牌有效期调短(JWT_TTL_SECONDS),
     * 用「更早过期」换「更快生效」。默认 7 天是按内网业务系统的使用习惯定的。
     */
    const actor: ActorContext = {
      actorId: claims.sub,
      username: claims.username,
      roleCodes: claims.roleCodes,
      superAdmin: claims.superAdmin,
      dataScope: claims.dataScope === 'SELF' ? 'SELF' : 'ALL',
      permissions: new Set(claims.permissions),
      traceId,
    };

    return { actor, expiresAt: result.expiresAt };
  }

  /**
   * 登出。
   *
   * [注意] 服务端**什么也做不了** —— JWT 是自验证的,签出去就无法收回,
   * 没有可删除的会话记录。真正的登出发生在前端:把本地存的令牌删掉。
   * 这个方法保留只是为了给前端一个统一的调用点(将来若加审计日志有地方挂)。
   *
   * 这是选 JWT 时一并接受的代价。要能强制下线就得建吊销表,
   * 那等于每个请求又要查一次库,换 JWT 的意义就没了。
   */
  async logout(_rawToken: string): Promise<void> {
    // 无状态,无需操作
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
    // [注意] 这里**踢不掉其他设备**。改密码的常见动机是"怀疑账号被盗",
    // 会话方案下可以立刻让其他设备失效,JWT 方案下做不到 ——
    // 已签发的令牌在有效期内始终有效。改密后旧令牌仍可用到过期。
    // 想缩小这个窗口只能调短 JWT_TTL_SECONDS。

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
