/**
 * 角色路由测试。
 *
 * 与 role.service.test.ts 分工一致:那边验业务规则,这里验接线。
 * 重点是两条只有在 HTTP 层才成立的事:
 *   1. 固定路径 /roles/options 必须排在 /roles/:id 之前,否则 'options' 会被当成 id
 *   2. options 用的是 user:read 而不是 role:read —— 编辑用户时要选角色,
 *      一个只管用户的人不该被迫拥有角色管理页的权限
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, postJson, setupTestApp, type TestApp } from '../../../tests/helpers/test-app.js';

interface ErrorBody {
  code: string;
  traceId: string;
}

interface OptionsBody {
  items: Array<{ id: string; code: string; name: string }>;
}

interface RoleListBody {
  items: Array<{ code: string; userCount: number }>;
  total: number;
}

describe('角色路由', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await setupTestApp();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  // ── 路由注册顺序 ────────────────────────────────────────────────

  it('should_match_options_before_id_route_when_path_is_fixed', async () => {
    const res = await authed(t.app, t.adminToken)('/roles/options');
    expect(res.status).toBe(200);

    const body = (await res.json()) as OptionsBody;
    // 拿到的是选项清单,不是"id 为 options 的角色不存在"
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toHaveProperty('code');
  });

  it('should_return_404_for_unknown_role_id_when_id_is_not_a_fixed_path', async () => {
    const res = await authed(t.app, t.adminToken)('/roles/no-such-role-id');
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).code).toBe('ROLE_NOT_FOUND');
  });

  // ── 权限码 ──────────────────────────────────────────────────────

  it('should_reject_role_list_with_403_when_actor_lacks_role_read', async () => {
    // viewer 只有 user:read
    const res = await authed(t.app, t.viewerToken)('/roles?page=1&size=10');
    expect(res.status).toBe(403);
  });

  it('should_allow_options_with_user_read_when_actor_lacks_role_read', async () => {
    // 这条固化了上面那个刻意的权限选择 —— 别"顺手"把它改成 role:read
    const res = await authed(t.app, t.viewerToken)('/roles/options');
    expect(res.status).toBe(200);
  });

  it('should_reject_create_with_403_when_actor_lacks_role_manage', async () => {
    const res = await postJson(t.app, t.viewerToken, '/roles/create', {
      code: 'NOPE',
      name: '不该建成',
      description: null,
      dataScope: 'ALL',
      permissions: [],
    });
    expect(res.status).toBe(403);
  });

  // ── 正常路径 ────────────────────────────────────────────────────

  it('should_create_role_when_actor_has_role_manage', async () => {
    const res = await postJson(t.app, t.adminToken, '/roles/create', {
      code: 'CREATED_BY_ADMIN',
      name: '管理员建的',
      description: null,
      dataScope: 'ALL',
      permissions: ['user:read'],
    });

    expect(res.status).toBe(201);
    expect((await res.json()) as { id: string }).toHaveProperty('id');
  });

  it('should_include_user_count_when_listing', async () => {
    const res = await authed(t.app, t.adminToken)('/roles?page=1&size=50');
    const body = (await res.json()) as RoleListBody;

    // 列表页要显示"多少人在用",删角色前也靠它判断
    const admin = body.items.find((i) => i.code === 'ADMIN');
    expect(admin?.userCount).toBe(1);
  });

  it('should_reject_duplicate_code_with_409_when_code_taken', async () => {
    const body = {
      code: 'DUP_VIA_HTTP',
      name: '重复码',
      description: null,
      dataScope: 'ALL',
      permissions: [],
    };
    expect((await postJson(t.app, t.adminToken, '/roles/create', body)).status).toBe(201);

    const res = await postJson(t.app, t.adminToken, '/roles/create', body);
    // 409 而不是 500 —— 仓储把 P2002 翻译成了业务码
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).code).toBe('ROLE_CODE_TAKEN');
  });

  // ── 行级数据权限 ────────────────────────────────────────────────

  it('should_hide_seeded_roles_from_list_when_actor_scope_is_self', async () => {
    const res = await authed(t.app, t.scopedToken)('/roles?page=1&size=50');
    const body = (await res.json()) as RoleListBody;

    // 夹具建的角色 createdBy 为 null,对 SELF 主体不可见
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('should_return_404_for_others_role_when_actor_scope_is_self', async () => {
    // 先用 admin 拿一个真实存在的角色 id
    const list = (await (
      await authed(t.app, t.adminToken)('/roles?page=1&size=1')
    ).json()) as { items: Array<{ id: string }> };
    const someRoleId = list.items[0]?.id;
    expect(someRoleId).toBeTruthy();

    const res = await authed(t.app, t.scopedToken)(`/roles/${someRoleId}`);

    // 列表里看不见,直接按 id 访问也必须看不见
    expect(res.status).toBe(404);
  });

  it('should_see_own_role_when_actor_scope_is_self', async () => {
    // 反向验证:不是"SELF 主体什么角色都访问不了"的假绿
    const created = await postJson(t.app, t.scopedToken, '/roles/create', {
      code: 'MADE_BY_SCOPED',
      name: '受限用户建的',
      description: null,
      dataScope: 'ALL',
      permissions: [],
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const res = await authed(t.app, t.scopedToken)(`/roles/${id}`);
    expect(res.status).toBe(200);
  });
});
