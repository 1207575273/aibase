/**
 * 角色服务 —— RBAC 的中间层管理。
 */

import type { ActorContext } from '../../domain/auth/actor.js';
import { AUTH_ERROR } from '../../domain/auth/auth.errors.js';
import type { DataScope } from '../../domain/auth/actor.js';
import type { Role } from '../../domain/auth/auth.types.js';
import type { RoleRepository, RoleWithUserCount } from '../../domain/auth/role.repository.js';
import type { UserRepository } from '../../domain/auth/user.repository.js';
import { conflict, mustFind } from '../../domain/shared/app-error.js';
import type { Clock } from '../../domain/shared/clock.js';
import type { IdGenerator } from '../../domain/shared/id-generator.js';
import type { Logger } from '../../domain/shared/logger.js';
import { toPageParams, type Page } from '../../domain/shared/page.js';

export interface RoleServiceDeps {
  roleRepo: RoleRepository;
  userRepo: UserRepository;
  ids: IdGenerator;
  clock: Clock;
  logger: Logger;
}

export interface CreateRoleInput {
  code: string;
  name: string;
  description: string | null;
  dataScope: DataScope;
  permissions: string[];
}

export type UpdateRoleInput = Omit<CreateRoleInput, 'code'>;

export interface ListRoleInput {
  page: number;
  size: number;
  keyword?: string | undefined;
}

export class RoleService {
  constructor(private readonly deps: RoleServiceDeps) {}

  async create(input: CreateRoleInput, actor: ActorContext): Promise<{ id: string }> {
    const now = this.deps.clock();
    const role: Role = {
      id: this.deps.ids.next(),
      code: input.code,
      name: input.name,
      description: input.description,
      // 超管标志**不开放给接口** —— 只能由 seed 创建。
      // 开放的话任何有 role:manage 权限的人都能给自己造一个超管角色,等于提权后门。
      superAdmin: false,
      builtin: false,
      dataScope: input.dataScope,
      permissions: input.permissions,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.actorId,
      updatedBy: actor.actorId,
    };

    await this.deps.roleRepo.create(role);

    this.deps.logger.info('创建角色', {
      roleId: role.id,
      code: role.code,
      actorId: actor.actorId,
      traceId: actor.traceId,
    });
    return { id: role.id };
  }

  async get(id: string): Promise<Role> {
    return mustFind(
      () => this.deps.roleRepo.findById(id),
      AUTH_ERROR.ROLE_NOT_FOUND,
      `角色不存在: ${id}`,
    );
  }

  async list(input: ListRoleInput): Promise<Page<RoleWithUserCount>> {
    return this.deps.roleRepo.list({
      ...toPageParams(input.page, input.size),
      keyword: input.keyword,
    });
  }

  /** 角色下拉选项。不分页 —— 角色数量业务上就是有限的。 */
  async listForPicker(): Promise<Array<Pick<Role, 'id' | 'code' | 'name'>>> {
    return this.deps.roleRepo.listAllForPicker();
  }

  async update(id: string, input: UpdateRoleInput, actor: ActorContext): Promise<void> {
    const existing = await mustFind(
      () => this.deps.roleRepo.findById(id),
      AUTH_ERROR.ROLE_NOT_FOUND,
      `角色不存在: ${id}`,
    );

    // 内置角色可以改名字和权限,但不能改 code —— code 是代码里可能被引用的标识。
    // (当前实现里 code 不在 UpdateRoleInput 中,这条是防御性的双保险。)

    await this.deps.roleRepo.update(
      id,
      {
        name: input.name,
        description: input.description,
        dataScope: input.dataScope,
        updatedAt: this.deps.clock(),
        updatedBy: actor.actorId,
      },
      input.permissions,
    );

    this.deps.logger.info('更新角色', {
      roleId: id,
      code: existing.code,
      actorId: actor.actorId,
      traceId: actor.traceId,
    });
  }

  async remove(id: string, actor: ActorContext): Promise<void> {
    const existing = await mustFind(
      () => this.deps.roleRepo.findById(id),
      AUTH_ERROR.ROLE_NOT_FOUND,
      `角色不存在: ${id}`,
    );

    if (existing.builtin) {
      throw conflict(AUTH_ERROR.BUILTIN_ROLE_READONLY, `内置角色 ${existing.code} 不允许删除`);
    }

    // 先 count 是为了给出可读的报错("还有 3 个用户在用")。
    // 数据库侧 user_role.roleId 是 onDelete: Restrict,是并发下的兜底 ——
    // 两道防线各有用途,不是重复。
    const userCount = await this.deps.userRepo.countByRoleId(id);
    if (userCount > 0) {
      throw conflict(
        AUTH_ERROR.ROLE_IN_USE,
        `仍有 ${userCount} 个用户持有该角色,请先解除关联`,
        { userCount },
      );
    }

    await this.deps.roleRepo.delete(id);

    this.deps.logger.warn('删除角色', {
      roleId: id,
      code: existing.code,
      actorId: actor.actorId,
      traceId: actor.traceId,
    });
  }
}
