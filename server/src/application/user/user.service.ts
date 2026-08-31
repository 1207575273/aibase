/**
 * 用户服务 —— 系统用户的管理。
 *
 * 这个 Service 示范了 UnitOfWork 的真实用途:
 * 「改用户」这个动作可能同时要写 sys_user、重建 sys_user_role、清 sys_session,
 * 三张表的写入必须原子 —— 中途失败留下"角色改了但会话没清"的状态是安全事故。
 */

import type { ActorContext } from '../../domain/auth/actor.js';
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

  async get(id: string): Promise<UserWithRoles> {
    return mustFind(
      () => this.deps.userRepo.findWithRoles(id),
      AUTH_ERROR.USER_NOT_FOUND,
      `用户不存在: ${id}`,
    );
  }

  async list(input: ListUserInput): Promise<Page<UserWithRoles>> {
    return this.deps.userRepo.list({
      ...toPageParams(input.page, input.size),
      keyword: input.keyword,
      status: input.status,
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

    // 禁止把自己禁用掉 —— 操作者会当场把自己锁在系统外面。
    if (id === actor.actorId && input.status === 'DISABLED') {
      throw invalid(AUTH_ERROR.CANNOT_DISABLE_SELF, '不能禁用自己的账号');
    }
    await this.assertRolesExist(input.roleIds);

    const now = this.deps.clock();
    const beingDisabled = existing.status === 'ACTIVE' && input.status === 'DISABLED';

    // 三张表的写入必须原子。这正是 UnitOfWork 存在的理由 ——
    // 姊妹项目没有这个抽象,只能把级联逻辑塞进仓储内部。
    await this.deps.uow.run(async (repos) => {
      await repos.user.update(id, {
        displayName: input.displayName,
        status: input.status,
        updatedAt: now,
        updatedBy: actor.actorId,
      });
      await repos.user.replaceRoles(id, input.roleIds);

      // 禁用要立刻踢掉全部在线会话,否则他手上已登录的标签页还能继续操作。
      if (beingDisabled) {
        await repos.session.deleteAllByUserId(id);
      }
    });

    this.deps.logger.info('更新用户', {
      userId: id,
      disabled: beingDisabled,
      actorId: actor.actorId,
      traceId: actor.traceId,
    });
  }

  /** 管理员重置密码:不需要原密码,但会踢掉该用户全部会话。 */
  async resetPassword(id: string, newPassword: string, actor: ActorContext): Promise<void> {
    await mustFind(
      () => this.deps.userRepo.findById(id),
      AUTH_ERROR.USER_NOT_FOUND,
      `用户不存在: ${id}`,
    );

    const now = this.deps.clock();
    const passwordHash = await this.deps.hasher.hash(newPassword);

    await this.deps.uow.run(async (repos) => {
      await repos.user.update(id, { passwordHash, updatedAt: now, updatedBy: actor.actorId });
      // 密码被管理员重置意味着"原持有者可能已失去控制",全部踢掉。
      await repos.session.deleteAllByUserId(id);
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

    // user_role 与 session 由数据库外键 Cascade 自动清理。
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
   */
  private async assertRolesExist(roleIds: readonly string[]): Promise<void> {
    for (const roleId of roleIds) {
      const role = await this.deps.roleRepo.findById(roleId);
      if (role === null) throw notFound(AUTH_ERROR.ROLE_NOT_FOUND, `角色不存在: ${roleId}`);
    }
  }
}
