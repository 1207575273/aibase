import { describe, expect, it } from 'vitest';
import {
  hasPermission,
  isInDataScope,
  mergeRoles,
  scopeOwnerOf,
  systemActor,
  type ActorContext,
  type RoleGrant,
} from './actor.js';

const actorWith = (over: Partial<ActorContext>): ActorContext => ({
  actorId: 'u1',
  username: 'tester',
  roleCodes: [],
  superAdmin: false,
  dataScope: 'SELF',
  permissions: new Set(),
  traceId: 't1',
  ...over,
});

const role = (over: Partial<RoleGrant>): RoleGrant => ({
  code: 'R',
  superAdmin: false,
  dataScope: 'SELF',
  permissions: [],
  ...over,
});

describe('hasPermission', () => {
  it('should_return_true_when_permission_granted', () => {
    const actor = actorWith({ permissions: new Set(['demo:read']) });
    expect(hasPermission(actor, 'demo:read')).toBe(true);
  });

  it('should_return_false_when_permission_missing', () => {
    const actor = actorWith({ permissions: new Set(['demo:read']) });
    expect(hasPermission(actor, 'demo:delete')).toBe(false);
  });

  it('should_return_true_for_any_code_when_super_admin', () => {
    const actor = actorWith({ superAdmin: true });
    // 超管即使权限集合为空也应放行 —— 这正是"新增模块无需给超管补勾"的机制
    expect(hasPermission(actor, 'demo:delete')).toBe(true);
    expect(hasPermission(actor, 'anything:at:all')).toBe(true);
  });
});

describe('mergeRoles', () => {
  it('should_union_permissions_when_multiple_roles', () => {
    const merged = mergeRoles([
      role({ code: 'A', permissions: ['demo:read', 'demo:create'] }),
      role({ code: 'B', permissions: ['demo:read', 'user:read'] }),
    ]);
    expect([...merged.permissions].sort()).toEqual(['demo:create', 'demo:read', 'user:read']);
    expect(merged.roleCodes).toEqual(['A', 'B']);
  });

  it('should_be_super_admin_when_any_role_is', () => {
    const merged = mergeRoles([role({ code: 'A' }), role({ code: 'B', superAdmin: true })]);
    expect(merged.superAdmin).toBe(true);
  });

  it('should_take_widest_data_scope_when_roles_differ', () => {
    const merged = mergeRoles([
      role({ code: 'A', dataScope: 'SELF' }),
      role({ code: 'B', dataScope: 'ALL' }),
    ]);
    expect(merged.dataScope).toBe('ALL');
  });

  it('should_keep_self_scope_when_all_roles_are_self', () => {
    const merged = mergeRoles([role({ code: 'A' }), role({ code: 'B' })]);
    expect(merged.dataScope).toBe('SELF');
  });

  it('should_fall_back_to_narrowest_when_no_roles', () => {
    // 兜底行为:忘了分配角色的用户应该什么都看不到,而不是看到全部
    const merged = mergeRoles([]);
    expect(merged.superAdmin).toBe(false);
    expect(merged.dataScope).toBe('SELF');
    expect(merged.permissions.size).toBe(0);
  });
});

describe('systemActor', () => {
  it('should_bypass_all_permission_checks', () => {
    expect(hasPermission(systemActor(), 'demo:delete')).toBe(true);
  });
});

/**
 * 行级数据权限的两个纯函数。
 *
 * 它们是整套 dataScope 机制的判定核心 —— Service 只负责调用,
 * 所以分支逻辑必须在这里被穷举,而不是留给一堆连库的 Service 测试去覆盖。
 */
describe('scopeOwnerOf', () => {
  it('should_return_undefined_when_scope_is_all', () => {
    // undefined = 不过滤
    expect(scopeOwnerOf(actorWith({ dataScope: 'ALL' }))).toBeUndefined();
  });

  it('should_return_actor_id_when_scope_is_self', () => {
    expect(scopeOwnerOf(actorWith({ actorId: 'u9', dataScope: 'SELF' }))).toBe('u9');
  });

  it('should_return_undefined_when_actor_is_super_admin', () => {
    // 超管豁免必须与 hasPermission 恒真一致,
    // 否则会出现"权限全有但数据看不见"的自相矛盾状态
    expect(scopeOwnerOf(actorWith({ dataScope: 'SELF', superAdmin: true }))).toBeUndefined();
  });
});

describe('isInDataScope', () => {
  it('should_allow_any_row_when_scope_is_all', () => {
    expect(isInDataScope('someone-else', actorWith({ dataScope: 'ALL' }))).toBe(true);
  });

  it('should_allow_own_row_when_scope_is_self', () => {
    expect(isInDataScope('u1', actorWith({ actorId: 'u1', dataScope: 'SELF' }))).toBe(true);
  });

  it('should_reject_others_row_when_scope_is_self', () => {
    expect(isInDataScope('u2', actorWith({ actorId: 'u1', dataScope: 'SELF' }))).toBe(false);
  });

  it('should_reject_ownerless_row_when_scope_is_self', () => {
    // createdBy 为 null 的是 seed 灌的内置数据,不属于任何人。
    // SELF 主体看不到它是正确行为 —— 别为了"方便"把 null 放行,
    // 那等于给每个受限用户开了一扇后门。
    expect(isInDataScope(null, actorWith({ actorId: 'u1', dataScope: 'SELF' }))).toBe(false);
  });

  it('should_allow_ownerless_row_when_actor_is_super_admin', () => {
    expect(isInDataScope(null, actorWith({ dataScope: 'SELF', superAdmin: true }))).toBe(true);
  });
});
