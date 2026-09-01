/**
 * RoleService 行为测试。
 *
 * 与 user.service.test.ts 同一个形状(真库、无 vi.mock、注入固定时钟),
 * 但这里不碰密码哈希,所以跑得快 —— 加业务模块时优先照抄这个文件。
 *
 * 重点验三类东西:
 *   1. 提权后门 —— superAdmin 不能通过接口设置
 *   2. 删除的两道防线 —— 内置角色、仍被持有
 *   3. 行级数据权限的四个入口,以及 listForPicker 的**有意豁免**
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../domain/shared/app-error.js';
import { AUTH_ERROR } from '../../domain/auth/auth.errors.js';
import type { ActorContext, DataScope } from '../../domain/auth/actor.js';
import { silentLogger } from '../../infrastructure/logger/silent-logger.js';
import { uuidGenerator } from '../../infrastructure/ids/uuid-generator.js';
import { PrismaRoleRepository } from '../../infrastructure/persistence/postgres/role.repository.js';
import { PrismaUserRepository } from '../../infrastructure/persistence/postgres/user.repository.js';
import { setupTestDb, type TestDb } from '../../../tests/helpers/test-db.js';
import { RoleService } from './role.service.js';

const FIXED_NOW = new Date('2026-01-01T08:00:00.000Z');

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

/** 只断 code —— message 会改,code 是对外契约。 */
const expectAppError = async (fn: () => Promise<unknown>, code: string): Promise<void> => {
  await expect(fn()).rejects.toSatisfy(
    (e: unknown) => e instanceof AppError && e.code === code,
    `应抛出 code 为 ${code} 的 AppError`,
  );
};

describe('RoleService', () => {
  let db: TestDb;
  let service: RoleService;
  let now: Date;

  const ALICE = 'alice-actor-id';
  const BOB = 'bob-actor-id';

  beforeEach(async () => {
    db = await setupTestDb();
    now = FIXED_NOW;

    service = new RoleService({
      roleRepo: new PrismaRoleRepository(db.prisma),
      userRepo: new PrismaUserRepository(db.prisma),
      ids: uuidGenerator,
      clock: () => now,
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    await db.cleanup();
  });

  const createRole = async (code: string, actorId = ALICE): Promise<string> => {
    const { id } = await service.create(
      { code, name: `名称-${code}`, description: null, dataScope: 'ALL', permissions: ['user:read'] },
      actorOf(actorId),
    );
    return id;
  };

  // ── 创建 ────────────────────────────────────────────────────────

  it('should_stamp_audit_fields_from_injected_clock_when_created', async () => {
    const id = await createRole('R1');

    const row = await db.prisma.role.findUniqueOrThrow({ where: { id } });
    expect(row.createdAt.toISOString()).toBe(FIXED_NOW.toISOString());
    expect(row.updatedAt.toISOString()).toBe(row.createdAt.toISOString());
    expect(row.createdBy).toBe(ALICE);
  });

  it('should_never_grant_super_admin_when_created_through_service', async () => {
    const id = await createRole('R1');

    // 提权后门防护: superAdmin 不在 CreateRoleInput 里,只能由 seed 写。
    // 开放的话任何有 role:manage 的人都能给自己造一个超管角色。
    const row = await db.prisma.role.findUniqueOrThrow({ where: { id } });
    expect(row.superAdmin).toBe(false);
    expect(row.builtin).toBe(false);
  });

  it('should_reject_duplicate_code_when_code_already_taken', async () => {
    await createRole('DUP');
    await expectAppError(() => createRole('DUP'), AUTH_ERROR.ROLE_CODE_TAKEN);
  });

  it('should_replace_permissions_wholesale_when_updated', async () => {
    const id = await createRole('R1');
    now = new Date('2026-03-03T10:00:00.000Z');

    await service.update(
      id,
      { name: '改过的', description: null, dataScope: 'SELF', permissions: ['role:read'] },
      actorOf(BOB),
    );

    const row = await db.prisma.role.findUniqueOrThrow({
      where: { id },
      include: { permissions: true },
    });
    // 全量替换,不是追加 —— user:read 应该没了
    expect(row.permissions.map((p) => p.code)).toEqual(['role:read']);
    expect(row.dataScope).toBe('SELF');
    expect(row.updatedAt.toISOString()).toBe(now.toISOString());
    expect(row.updatedBy).toBe(BOB);
  });

  // ── 删除的两道防线 ──────────────────────────────────────────────

  it('should_reject_deleting_builtin_role_when_role_is_builtin', async () => {
    const id = uuidGenerator.next();
    await db.prisma.role.create({
      data: {
        id,
        code: 'BUILTIN',
        name: '内置',
        superAdmin: false,
        builtin: true,
        dataScope: 'ALL',
        createdAt: now,
        updatedAt: now,
        createdBy: ALICE,
      },
    });

    await expectAppError(
      () => service.remove(id, actorOf(ALICE)),
      AUTH_ERROR.BUILTIN_ROLE_READONLY,
    );
  });

  it('should_reject_deleting_role_when_still_held_by_user', async () => {
    const roleId = await createRole('IN_USE');
    await db.prisma.user.create({
      data: {
        id: uuidGenerator.next(),
        username: 'holder',
        displayName: '持有者',
        passwordHash: 'x',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        roles: { create: [{ roleId }] },
      },
    });

    await expectAppError(() => service.remove(roleId, actorOf(ALICE)), AUTH_ERROR.ROLE_IN_USE);
    expect(await db.prisma.role.count({ where: { id: roleId } })).toBe(1);
  });

  it('should_delete_role_when_no_one_holds_it', async () => {
    const roleId = await createRole('FREE');

    await service.remove(roleId, actorOf(ALICE));

    expect(await db.prisma.role.count({ where: { id: roleId } })).toBe(0);
  });

  // ── 行级数据权限的四个入口 ──────────────────────────────────────

  it('should_return_only_own_rows_when_actor_scope_is_self', async () => {
    await createRole('BY_ALICE', ALICE);
    await createRole('BY_BOB', BOB);

    const page = await service.list({ page: 1, size: 20 }, actorOf(ALICE, 'SELF'));

    expect(page.items.map((i) => i.role.code)).toEqual(['BY_ALICE']);
    // total 与 items 同口径
    expect(page.total).toBe(1);
  });

  it('should_reject_get_of_others_row_when_actor_scope_is_self', async () => {
    const bobs = await createRole('BY_BOB', BOB);

    // 404 而不是 403,理由见 RoleService.assertInScope
    await expectAppError(
      () => service.get(bobs, actorOf(ALICE, 'SELF')),
      AUTH_ERROR.ROLE_NOT_FOUND,
    );
  });

  it('should_reject_update_of_others_row_when_actor_scope_is_self', async () => {
    const bobs = await createRole('BY_BOB', BOB);

    await expectAppError(
      () =>
        service.update(
          bobs,
          { name: '被越权改名', description: null, dataScope: 'ALL', permissions: [] },
          actorOf(ALICE, 'SELF'),
        ),
      AUTH_ERROR.ROLE_NOT_FOUND,
    );

    const row = await db.prisma.role.findUniqueOrThrow({ where: { id: bobs } });
    expect(row.name).not.toBe('被越权改名');
  });

  it('should_reject_delete_of_others_row_when_actor_scope_is_self', async () => {
    const bobs = await createRole('BY_BOB', BOB);

    await expectAppError(
      () => service.remove(bobs, actorOf(ALICE, 'SELF')),
      AUTH_ERROR.ROLE_NOT_FOUND,
    );
    expect(await db.prisma.role.count({ where: { id: bobs } })).toBe(1);
  });

  it('should_bypass_scope_when_actor_is_super_admin', async () => {
    const bobs = await createRole('BY_BOB', BOB);

    // 超管即使 dataScope=SELF 也能访问 —— 与 hasPermission 恒真保持一致
    const found = await service.get(bobs, actorOf(ALICE, 'SELF', true));
    expect(found.code).toBe('BY_BOB');
  });

  it('should_list_all_roles_for_picker_regardless_of_scope', async () => {
    await createRole('BY_ALICE', ALICE);
    await createRole('BY_BOB', BOB);

    const options = await service.listForPicker();

    /*
     * [固化一个有意的决定] 下拉选项**不做** scope 过滤,与 list() 不同。
     *
     * 它是"可分配的角色目录"而不是"我管理的数据",只暴露 id/code/name。
     * 做了过滤的话,dataScope=SELF 的管理员会看不到 seed 灌的内置角色
     * (createdBy 为 null),建号时一个角色都选不了,功能直接残废。
     *
     * 这条用例在这里是为了防止后来者把它"修"成过滤版 —— 那不是修 bug。
     */
    expect(options.map((o) => o.code).sort()).toEqual(['BY_ALICE', 'BY_BOB']);
  });
});
