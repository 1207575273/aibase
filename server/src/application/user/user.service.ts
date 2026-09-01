/**
 * 用户服务 —— 系统用户的管理。
 *
 * 这个 Service 示范两件事,加业务模块时照抄:
 *
 * 1. **UnitOfWork 的真实用途**:「改用户」要同时写 sys_user 和重建 sys_user_role,
 *    两张表的写入必须原子 —— 中途失败留下"基本信息改了但角色没换"的状态。
 *
 * 2. **行级数据权限的四个入口**:list / get / update / remove(以及 resetPassword)
 *    **每一个**都要过 scope 判定。只做列表是经典漏洞:列表里看不到那一行,
 *    但知道 id 就能直接 GET /users/:id 读出来、POST /users/:id/update 改掉它。
 *    判定逻辑是 domain 的纯函数 scopeOwnerOf / isInDataScope,这里只负责调用。
 */

import { isInDataScope, scopeOwnerOf, type ActorContext } from '../../domain/auth/actor.js';
import { AUTH_ERROR } from '../../domain/auth/auth.errors.js';
import type { User, UserStatus } from '../../domain/auth/auth.types.js';
import type { PasswordHasher } from '../../domain/auth/password-hasher.js';
import type { RoleRepository } from '../../domain/auth/role.repository.js';
import type { UserRepository, UserWithRoles } from '../../domain/auth/user.repository.js';
import { invalid, mustFind, notFound } from '../../domain/shared/app-error.js';
import type { Clock } from '../../domain/shared/clock.js';
import type { IdGenerator } from '../../domain/shared/id-generator.js';
import type { Logger } from '../../domain/shared/logger.js';
import { toPageParams, type Page } from '../../domain/shared/page.js';
import type { UnitOfWork } from '../../domain/shared/unit-of-work.js';

export interface UserServiceDeps {
  userRepo: UserRepository;
  roleRepo: RoleRepository;
  hasher: PasswordHasher;
  uow: UnitOfWork;
  ids: IdGenerator;
  clock: Clock;
  logger: Logger;
}

export interface CreateUserInput {
  username: string;
  displayName: string;
  password: string;
  roleIds: string[];
}

export interface UpdateUserInput {
  displayName: string;
  status: UserStatus;
  roleIds: string[];
}

export interface ListUserInput {
  page: number;
  size: number;
  keyword?: string | undefined;
  status?: UserStatus | undefined;
}

export class UserService {
  constructor(private readonly deps: UserServiceDeps) {}

  async create(input: CreateUserInput, actor: ActorContext): Promise<{ id: string }> {
    await this.assertRolesExist(input.roleIds);

    const now = this.deps.clock();
    const user: User = {
      id: this.deps.ids.next(),
      username: input.username,
      displayName: input.displayName,
      passwordHash: await this.deps.hasher.hash(input.password),
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      createdBy: actor.actorId,
      updatedBy: actor.actorId,
    };

    // 用户与角色绑定在仓储里用 Prisma 嵌套写完成,天然原子,不需要额外事务。
    await this.deps.userRepo.create(user, input.roleIds);

    this.deps.logger.info('创建用户', {
      userId: user.id,
      username: user.username,
      actorId: actor.actorId,
      traceId: actor.traceId,
    });
    return { id: user.id };
  }

  async get(id: string, actor: ActorContext): Promise<UserWithRoles> {
    const found = await mustFind(
      () => this.deps.userRepo.findWithRoles(id),
      AUTH_ERROR.USER_NOT_FOUND,
      `用户不存在: ${id}`,
    );
    this.assertInScope(found.user.createdBy, actor, id);
    return found;
  }

  async list(input: ListUserInput, actor: ActorContext): Promise<Page<UserWithRoles>> {
    return this.deps.userRepo.list({
      ...toPageParams(input.page, input.size),
      keyword: input.keyword,
      status: input.status,
      scopeOwnerId: scopeOwnerOf(actor),
    });
  }

  /**
   * 更新用户:改名 + 改状态 + 换角色,一次完成。
   *
   * 为什么折叠成一个端点而不是拆成 /update /enable /disable /assign-roles 四个:
   * 拆开的话前端保存一次表单要发四次请求,而且四个动作之间**没有事务边界** ——
   * 改到一半失败就留下不一致状态。
   */
  async update(id: string, input: UpdateUserInput, actor: ActorContext): Promise<void> {
    const existing = await mustFind(
      () => this.deps.userRepo.findById(id),
      AUTH_ERROR.USER_NOT_FOUND,
      `用户不存在: ${id}`,
    );
    this.assertInScope(existing.createdBy, actor, id);

    // 禁止把自己禁用掉 —— 操作者会当场把自己锁在系统外面。
    if (id === actor.actorId && input.status === 'DISABLED') {
      throw invalid(AUTH_ERROR.CANNOT_DISABLE_SELF, '不能禁用自己的账号');
    }
    await this.assertRolesExist(input.roleIds);

    const now = this.deps.clock();
    const beingDisabled = existing.status === 'ACTIVE' && input.status === 'DISABLED';

    // sys_user 与 sys_user_role 两张表的写入必须原子:中途失败会留下
    // "基本信息改了但角色没换"的状态。这正是 UnitOfWork 存在的理由 ——
    // 曾见过的一个项目没有这个抽象,只能把级联逻辑塞进仓储内部。
    await this.deps.uow.run(async (repos) => {
      await repos.user.update(id, {
        displayName: input.displayName,
        status: input.status,
        updatedAt: now,
        updatedBy: actor.actorId,
      });
      await repos.user.replaceRoles(id, input.roleIds);

      /*
       * [限制] 禁用**不能立刻生效**。
       *
       * 会话方案下这里会删掉该用户的全部在线会话,他手上已登录的标签页立刻失效。
       * JWT 方案下服务端不持有任何可删除的东西 —— 已签发的令牌在有效期内始终验得过,
       * 被禁用的人最长可以继续操作到 JWT_TTL_SECONDS 耗尽。
       *
       * 要缩短这个窗口只能调短令牌有效期;要立即失效只能换回会话查库。
       * 这是选 JWT 时一并接受的代价,不是这里漏了一行。
       */
    });

    this.deps.logger.info('更新用户', {
      userId: id,
      disabled: beingDisabled,
      actorId: actor.actorId,
      traceId: actor.traceId,
    });
  }

  /**
   * 管理员重置密码:不需要原密码。
   *
   * [限制] 重置密码**踢不掉**该用户已登录的设备 —— JWT 是自验证的,
   * 旧令牌在 JWT_TTL_SECONDS 耗尽前始终有效。密码被管理员重置通常意味着
   * "原持有者可能已失去控制",这个窗口值得注意,缩小它只能调短令牌有效期。
   */
  async resetPassword(id: string, newPassword: string, actor: ActorContext): Promise<void> {
    const existing = await mustFind(
      () => this.deps.userRepo.findById(id),
      AUTH_ERROR.USER_NOT_FOUND,
      `用户不存在: ${id}`,
    );
    this.assertInScope(existing.createdBy, actor, id);

    const now = this.deps.clock();
    const passwordHash = await this.deps.hasher.hash(newPassword);

    // 单条写入,不套 uow.run ——
    // 会话方案下这里还要顺带清 sys_session 才需要事务,JWT 之后只剩这一条 update。
    // 包一个只有一次写的事务是空壳,徒增读代码的人的困惑。
    await this.deps.userRepo.update(id, {
      passwordHash,
      updatedAt: now,
      updatedBy: actor.actorId,
    });

    this.deps.logger.warn('管理员重置了用户密码', {
      userId: id,
      actorId: actor.actorId,
      traceId: actor.traceId,
    });
  }

  async remove(id: string, actor: ActorContext): Promise<void> {
    if (id === actor.actorId) {
      throw invalid(AUTH_ERROR.CANNOT_DELETE_SELF, '不能删除自己的账号');
    }
    const existing = await mustFind(
      () => this.deps.userRepo.findById(id),
      AUTH_ERROR.USER_NOT_FOUND,
      `用户不存在: ${id}`,
    );
    this.assertInScope(existing.createdBy, actor, id);

    // user_role 由数据库外键 Cascade 自动清理。
    await this.deps.userRepo.delete(id);

    this.deps.logger.warn('删除用户', {
      userId: id,
      username: existing.username,
      actorId: actor.actorId,
      traceId: actor.traceId,
    });
  }

  /**
   * 校验角色 id 全部存在。
   *
   * 这是业务规则校验(不是格式校验),所以放在 Service 而不是 zod。
   * 不校验的话数据库外键会拒绝,但报错信息是 "FK_VIOLATION" 这种用户看不懂的东西。
   *
   * 一次 findByIds 查完,不在循环里逐个查 —— 那是 N+1,
   * 而这个方法是被 create 和 update 两条主路径调用的。
   */
  private async assertRolesExist(roleIds: readonly string[]): Promise<void> {
    if (roleIds.length === 0) return;

    const found = await this.deps.roleRepo.findByIds(roleIds);
    const foundIds = new Set(found.map((r) => r.id));
    const missing = roleIds.find((id) => !foundIds.has(id));

    if (missing !== undefined) {
      throw notFound(AUTH_ERROR.ROLE_NOT_FOUND, `角色不存在: ${missing}`);
    }
  }

  /**
   * 行级数据权限断言 —— 越界时抛 **404 而不是 403**。
   *
   * 403 等于承认"这条记录存在,只是你不能碰",配合可枚举的 id 就成了存在性探测接口。
   * 404 让"不存在"与"不归你管"对外不可区分,与列表里看不到它保持一致。
   */
  private assertInScope(createdBy: string | null, actor: ActorContext, id: string): void {
    if (!isInDataScope(createdBy, actor)) {
      throw notFound(AUTH_ERROR.USER_NOT_FOUND, `用户不存在: ${id}`);
    }
  }
}
