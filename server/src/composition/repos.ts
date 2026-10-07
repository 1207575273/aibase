/**
 * 仓储清单 —— 全仓唯一知道"有哪些仓储"的地方。
 *
 * 干什么: 用给定的客户端组装一整套仓储。
 *   参数既可以是完整的 PrismaClient(普通场景),也可以是事务客户端(UnitOfWork 里),
 *   因为 PrismaClient 本身就可以赋值给更窄的 DbClient。
 *
 * 新增一个业务模块时在 RepoBundle 和 buildRepos 各加一行。
 * 放在 composition 而不是 lib / platform: 那两层不允许依赖业务模块。
 */

import type { DbClient } from '../platform/db/db-client.js';
import type { RoleRepository } from '../modules/identity/domain/role.repository.js';
import type { UserRepository } from '../modules/identity/domain/user.repository.js';
import { PrismaRoleRepository } from '../modules/identity/infra/role.repository.js';
import { PrismaUserRepository } from '../modules/identity/infra/user.repository.js';

export interface RepoBundle {
  user: UserRepository;
  role: RoleRepository;
}

export const buildRepos = (db: DbClient): RepoBundle => ({
  user: new PrismaUserRepository(db),
  role: new PrismaRoleRepository(db),
});
