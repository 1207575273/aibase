/**
 * UserService 行为测试 —— **加业务模块时照抄这个形状**。
 *
 * 这个文件示范三件事:
 *
 * 1. **不用 vi.mock**。直接 new Service,注入真实的 Prisma 仓储(连临时 SQLite)
 *    + 字面量 clock/ids/logger。假件比真件更容易骗过自己:
 *    内存假件不会有唯一约束、不会抛 P2002,而那正是最需要被测的分支。
 *
 * 2. **时钟注入的价值**。clock 是个可变闭包,测试能把"现在"钉死,
 *    于是"同一次创建的 createdAt 与 updatedAt 严格相等"这种事实可以直接断言 ——
 *    用 @default(now()) 的话这条断言写不出来。
 *
 * 3. **行级数据权限的四个入口都要测**。list 只是其中一个;
 *    get/update/remove/resetPassword 各有一条越界用例。
 *    只测列表是经典漏洞:知道 id 就能绕过列表直接访问。
 *
 * [慢] 这个文件跑约 50 秒,因为每次建用户都要跑一次真实 scrypt(单次 64MiB)。
 *   要提速只能给 ScryptPasswordHasher 加一个测试专用的低成本参数 ——
 *   那会动到安全相关的生产代码,不值得为测试时间去改。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../lib/app-error.js';
import { AUTH_ERROR } from '../domain/auth.errors.js';
import type { ActorContext, DataScope } from '../../../lib/actor.js';
import { silentLogger } from '../../../platform/logger/silent-logger.js';
import { uuidGenerator } from '../../../platform/uuid-generator.js';
import { PrismaRoleRepository } from '../infra/role.repository.js';
import { PrismaUnitOfWork } from '../../../platform/db/unit-of-work.js';
import { buildRepos } from '../../../composition/repos.js';
import { PrismaUserRepository } from '../infra/user.repository.js';
import { ScryptPasswordHasher } from '../infra/scrypt-password-hasher.js';
import { setupTestDb, type TestDb } from '../../../../tests/helpers/test-db.js';
import { UserService } from './user.service.js';

const FIXED_NOW = new Date('2026-01-01T08:00:00.000Z');

/** 只填 Service 会用到的字段。permissions 是路由层的事,Service 不看它。 */
const actorOf = (
  actorId: string,
  dataScope: DataScope = 'ALL',
  superAdmin = false,
): ActorContext => ({
  actorId,
  username: `user-${actorId}`,
  roleCodes: [],
  superAdmin,
  dataScope,
  permissions: new Set(),
  traceId: 'test-trace',
});

/**
 * 断言抛出的是带指定 code 的 AppError。
 * 只断 code 不断 message —— message 随时会改,code 是对外契约的一部分。
 * 刻意只调用 fn 一次: 这些操作里有密码哈希,跑两遍纯属浪费。
 */
const expectAppError = async (fn: () => Promise<unknown>, code: string): Promise<void> => {
  await expect(fn()).rejects.toSatisfy(
    (e: unknown) => e instanceof AppError && e.code === code,
    `应抛出 code 为 ${code} 的 AppError`,
  );
};

describe('UserService', () => {
  let db: TestDb;
  let service: UserService;
  let now: Date;
  let roleId: string;

  /** 两个不同的操作者,用来验"谁创建的数据归谁"。 */
  const ALICE = 'alice-actor-id';
  const BOB = 'bob-actor-id';

  beforeEach(async () => {
    db = await setupTestDb();
    now = FIXED_NOW;

    const userRepo = new PrismaUserRepository(db.prisma);
    const roleRepo = new PrismaRoleRepository(db.prisma);

    service = new UserService({
      userRepo,
      roleRepo,
      hasher: new ScryptPasswordHasher(),
      uow: new PrismaUnitOfWork(db.prisma, buildRepos),
      ids: uuidGenerator,
      clock: () => now,
      logger: silentLogger,
    });

    // 一个可用的角色 —— 建用户必须带合法 roleId
    roleId = uuidGenerator.next();
    await db.prisma.role.create({
      data: {
        id: roleId,
        code: 'TESTER',
        name: '测试角色',
        superAdmin: false,
        builtin: false,
        dataScope: 'ALL',
        createdAt: now,
        updatedAt: now,
      },
    });
  });

  afterEach(async () => {
    await db.cleanup();
  });

  /** 造一个用户,返回 id。默认由 ALICE 创建。 */
  const createUser = async (username: string, actorId = ALICE): Promise<string> => {
    const { id } = await service.create(
      { username, displayName: `显示名-${username}`, password: 'pass-12345678', roleIds: [roleId] },
      actorOf(actorId),
    );
    return id;
  };

  // ── 创建 ────────────────────────────────────────────────────────

  it('should_stamp_audit_fields_from_injected_clock_when_created', async () => {
    const id = await createUser('u1');

    const row = await db.prisma.user.findUniqueOrThrow({ where: { id } });
    expect(row.createdAt.toISOString()).toBe(FIXED_NOW.toISOString());
    // 同一次创建的两个时间戳严格相等 —— @updatedAt 做不到这一点
    expect(row.updatedAt.toISOString()).toBe(row.createdAt.toISOString());
    expect(row.createdBy).toBe(ALICE);
    expect(row.updatedBy).toBe(ALICE);
  });

  it('should_never_store_password_in_plaintext_when_created', async () => {
    const id = await createUser('u1');

    const row = await db.prisma.user.findUniqueOrThrow({ where: { id } });
    expect(row.passwordHash).not.toContain('pass-12345678');
    // PHC 风格串,换算法时靠它识别旧格式并自动升级
    expect(row.passwordHash.startsWith('$scrypt$')).toBe(true);
  });

  it('should_reject_duplicate_username_when_username_already_taken', async () => {
    await createUser('dup');

    // 唯一性由 DB 约束 + P2002 翻译保证,不是"先查后写" ——
    // 这条用例同时守着仓储里的 mapPrismaError 登记没被漏掉
    await expectAppError(() => createUser('dup'), AUTH_ERROR.USERNAME_TAKEN);
  });

  it('should_reject_unknown_role_when_role_does_not_exist', async () => {
    await expectAppError(
      () =>
        service.create(
          {
            username: 'u-bad-role',
            displayName: '坏角色',
            password: 'pass-12345678',
            roleIds: [uuidGenerator.next()],
          },
          actorOf(ALICE),
        ),
      AUTH_ERROR.ROLE_NOT_FOUND,
    );
  });

  // ── 行级数据权限:列表 ──────────────────────────────────────────

  it('should_return_only_own_rows_when_actor_scope_is_self', async () => {
    await createUser('by-alice', ALICE);
    await createUser('by-bob', BOB);

    const page = await service.list({ page: 1, size: 20 }, actorOf(ALICE, 'SELF'));

    expect(page.items.map((i) => i.user.username)).toEqual(['by-alice']);
  });

  it('should_count_total_within_scope_when_actor_scope_is_self', async () => {
    await createUser('by-alice', ALICE);
    await createUser('by-bob-1', BOB);
    await createUser('by-bob-2', BOB);

    const page = await service.list({ page: 1, size: 20 }, actorOf(ALICE, 'SELF'));

    // total 必须与 items 同口径。两边各拼一次 where 的写法会在这里露馅:
    // 列表 1 条、总数 3 条,前端分页器直接错乱
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });

  it('should_return_all_rows_when_actor_scope_is_all', async () => {
    await createUser('by-alice', ALICE);
    await createUser('by-bob', BOB);

    const page = await service.list({ page: 1, size: 20 }, actorOf(ALICE, 'ALL'));

    expect(page.total).toBe(2);
  });

  it('should_bypass_scope_when_actor_is_super_admin', async () => {
    await createUser('by-bob', BOB);

    // 超管即使 dataScope=SELF 也看全部 —— 与 hasPermission 恒真保持一致,
    // 否则会出现"权限全有但数据看不见"的自相矛盾状态
    const page = await service.list({ page: 1, size: 20 }, actorOf(ALICE, 'SELF', true));

    expect(page.total).toBe(1);
  });

  it('should_paginate_when_size_is_smaller_than_total', async () => {
    await createUser('p1');
    await createUser('p2');
    await createUser('p3');

    const page = await service.list({ page: 2, size: 2 }, actorOf(ALICE));

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  // ── 行级数据权限:单条访问的四个入口 ────────────────────────────
  //
  // 这四条是这个文件里最值钱的用例。只做列表过滤是经典漏洞:
  // 列表里看不到那一行,但知道 id 就能直接读它、改它、删它。

  it('should_reject_get_of_others_row_when_actor_scope_is_self', async () => {
    const bobsUser = await createUser('by-bob', BOB);

    // 404 而不是 403 —— 403 等于承认"这条存在,只是你不能碰",
    // 配合可枚举 id 就成了存在性探测接口
    await expectAppError(
      () => service.get(bobsUser, actorOf(ALICE, 'SELF')),
      AUTH_ERROR.USER_NOT_FOUND,
    );
  });

  it('should_reject_update_of_others_row_when_actor_scope_is_self', async () => {
    const bobsUser = await createUser('by-bob', BOB);

    await expectAppError(
      () =>
        service.update(
          bobsUser,
          { displayName: '被越权改名', status: 'ACTIVE', roleIds: [roleId] },
          actorOf(ALICE, 'SELF'),
        ),
      AUTH_ERROR.USER_NOT_FOUND,
    );

    const row = await db.prisma.user.findUniqueOrThrow({ where: { id: bobsUser } });
    expect(row.displayName).not.toBe('被越权改名');
  });

  it('should_reject_delete_of_others_row_when_actor_scope_is_self', async () => {
    const bobsUser = await createUser('by-bob', BOB);

    await expectAppError(
      () => service.remove(bobsUser, actorOf(ALICE, 'SELF')),
      AUTH_ERROR.USER_NOT_FOUND,
    );

    expect(await db.prisma.user.count({ where: { id: bobsUser } })).toBe(1);
  });

  it('should_reject_reset_password_of_others_row_when_actor_scope_is_self', async () => {
    const bobsUser = await createUser('by-bob', BOB);
    const before = await db.prisma.user.findUniqueOrThrow({ where: { id: bobsUser } });

    await expectAppError(
      () => service.resetPassword(bobsUser, 'new-pass-12345', actorOf(ALICE, 'SELF')),
      AUTH_ERROR.USER_NOT_FOUND,
    );

    const after = await db.prisma.user.findUniqueOrThrow({ where: { id: bobsUser } });
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it('should_allow_access_to_own_row_when_actor_scope_is_self', async () => {
    const own = await createUser('by-alice', ALICE);

    // 反向验证:上面四条不是"SELF 什么都干不了"的假绿
    const found = await service.get(own, actorOf(ALICE, 'SELF'));
    expect(found.user.username).toBe('by-alice');
  });

  // ── 自我保护 ────────────────────────────────────────────────────

  it('should_reject_disabling_self_when_actor_is_the_target', async () => {
    const me = await createUser('me');

    await expectAppError(
      () =>
        service.update(
          me,
          { displayName: '我自己', status: 'DISABLED', roleIds: [roleId] },
          actorOf(me),
        ),
      AUTH_ERROR.CANNOT_DISABLE_SELF,
    );
  });

  it('should_reject_deleting_self_when_actor_is_the_target', async () => {
    const me = await createUser('me');

    await expectAppError(() => service.remove(me, actorOf(me)), AUTH_ERROR.CANNOT_DELETE_SELF);
  });

  // ── 更新 ────────────────────────────────────────────────────────

  it('should_replace_roles_and_bump_updated_at_when_updated', async () => {
    const id = await createUser('u1');

    const otherRoleId = uuidGenerator.next();
    await db.prisma.role.create({
      data: {
        id: otherRoleId,
        code: 'OTHER',
        name: '另一个角色',
        superAdmin: false,
        builtin: false,
        dataScope: 'ALL',
        createdAt: now,
        updatedAt: now,
      },
    });

    // 把时钟往前拨,验证 updatedAt 跟着走而 createdAt 不动
    now = new Date('2026-02-02T09:00:00.000Z');

    await service.update(
      id,
      { displayName: '新名字', status: 'ACTIVE', roleIds: [otherRoleId] },
      actorOf(BOB),
    );

    const row = await db.prisma.user.findUniqueOrThrow({
      where: { id },
      include: { roles: true },
    });
    expect(row.displayName).toBe('新名字');
    expect(row.createdAt.toISOString()).toBe(FIXED_NOW.toISOString());
    expect(row.updatedAt.toISOString()).toBe(now.toISOString());
    expect(row.updatedBy).toBe(BOB);
    // 全量替换,不是追加
    expect(row.roles.map((r) => r.roleId)).toEqual([otherRoleId]);
  });

  it('should_keep_roles_unchanged_when_update_rolls_back', async () => {
    const id = await createUser('u1');

    // 角色不存在 -> assertRolesExist 抛错 -> 整个 update 不该留下任何痕迹
    await expectAppError(
      () =>
        service.update(
          id,
          { displayName: '不该生效', status: 'ACTIVE', roleIds: [uuidGenerator.next()] },
          actorOf(ALICE),
        ),
      AUTH_ERROR.ROLE_NOT_FOUND,
    );

    const row = await db.prisma.user.findUniqueOrThrow({
      where: { id },
      include: { roles: true },
    });
    expect(row.displayName).toBe('显示名-u1');
    expect(row.roles.map((r) => r.roleId)).toEqual([roleId]);
  });

  it('should_change_password_hash_when_reset_by_admin', async () => {
    const id = await createUser('u1');
    const before = await db.prisma.user.findUniqueOrThrow({ where: { id } });

    await service.resetPassword(id, 'brand-new-pass-1', actorOf(BOB));

    const after = await db.prisma.user.findUniqueOrThrow({ where: { id } });
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(after.updatedBy).toBe(BOB);
  });

  it('should_cascade_delete_role_links_when_user_removed', async () => {
    const id = await createUser('u1');

    await service.remove(id, actorOf(BOB));

    expect(await db.prisma.user.count({ where: { id } })).toBe(0);
    // user_role 由外键 Cascade 清理,不需要仓储手工断链
    expect(await db.prisma.userRole.count({ where: { userId: id } })).toBe(0);
  });
});
