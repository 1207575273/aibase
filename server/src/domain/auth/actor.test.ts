import { describe, expect, it } from 'vitest';
import { hasPermission, mergeRoles, systemActor, type ActorContext, type RoleGrant } from './actor.js';

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
