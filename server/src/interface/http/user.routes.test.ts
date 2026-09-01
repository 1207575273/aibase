/**
 * 用户路由测试 —— 验的是**只有走完整个 HTTP 栈才验得到**的东西。
 *
 * 与 user.service.test.ts 的分工:
 *   Service 测试验业务规则(审计字段、越权拦截、事务回滚);
 *   这里验接线 —— 权限码挂对没有、行级权限在真实请求下生效没有、
 *   wire 有没有泄漏字段、校验失败走不走统一错误出口。
 *
 * 夹具给了三个身份(见 tests/helpers/test-app.ts):
 *   admin  超管,全权限、全数据
 *   viewer 只有 user:read —— 用来验权限码拦截
 *   scoped 权限齐全但 dataScope=SELF —— 用来验行级数据权限
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, postJson, setupTestApp, type TestApp } from '../../../tests/helpers/test-app.js';

interface ErrorBody {
  code: string;
  traceId: string;
  details?: { fields?: Array<{ field: string; message: string }> };
}

interface UserListBody {
  items: Array<{ id: string; username: string; roles: Array<{ code: string }> }>;
  total: number;
  page: number;
  size: number;
}

describe('用户路由', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await setupTestApp();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const createUser = async (token: string, username: string): Promise<Response> =>
    postJson(t.app, token, '/users/create', {
      username,
      displayName: `显示名-${username}`,
      password: 'pass-12345678',
      roleIds: [],
    });

  // ── 权限码 ──────────────────────────────────────────────────────

  it('should_allow_read_when_actor_has_user_read', async () => {
    const res = await authed(t.app, t.viewerToken)('/users?page=1&size=10');
    expect(res.status).toBe(200);
  });

  it('should_reject_create_with_403_when_actor_lacks_user_manage', async () => {
    const res = await createUser(t.viewerToken, 'should_not_exist');

    // 403 不是 401 —— 已登录但没权限。前端据此只提示而不跳登录页,
    // 跳错了会让用户陷入"登录 -> 被踢 -> 再登录"的死循环
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.code).toBe('FORBIDDEN');
  });

  // ── wire 形状 ───────────────────────────────────────────────────

  it('should_never_expose_password_hash_in_any_response', async () => {
    const res = await authed(t.app, t.adminToken)('/users?page=1&size=10');
    const text = await res.text();

    // 直接在整个响应文本里搜 —— 比逐字段断言更能兜住"新加字段忘了过滤"
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('$scrypt$');
  });

  it('should_return_page_envelope_when_listing', async () => {
    const res = await authed(t.app, t.adminToken)('/users?page=1&size=2');
    const body = (await res.json()) as UserListBody;

    expect(body.page).toBe(1);
    expect(body.size).toBe(2);
    expect(body.items.length).toBeLessThanOrEqual(2);
    // 夹具至少建了 admin/viewer/scoped 三个
    expect(body.total).toBeGreaterThanOrEqual(3);
  });

  // ── 校验走统一出口 ──────────────────────────────────────────────

  it('should_return_field_level_errors_when_body_is_invalid', async () => {
    const res = await postJson(t.app, t.adminToken, '/users/create', {
      username: '',
      displayName: '',
      password: 'short',
      roleIds: [],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    // 统一形状: 与业务错误同构,前端不需要为校验失败写第二套解析
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.traceId).toBeTruthy();
    expect(body.details?.fields?.length).toBeGreaterThan(0);
  });

  it('should_reject_page_size_over_limit_when_listing', async () => {
    // 分页上限是硬约束 —— 不能靠传一个大 size 把全表拉走
    const res = await authed(t.app, t.adminToken)('/users?page=1&size=9999');

    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).code).toBe('VALIDATION_FAILED');
  });

  // ── 行级数据权限(端到端)────────────────────────────────────────

  it('should_hide_others_rows_from_list_when_actor_scope_is_self', async () => {
    const created = await createUser(t.scopedToken, 'made_by_scoped');
    expect(created.status).toBe(201);

    const res = await authed(t.app, t.scopedToken)('/users?page=1&size=50');
    const body = (await res.json()) as UserListBody;

    // 只看得到自己建的那一个;admin/viewer/scoped 自己都是夹具直接写库的
    // (createdBy 为 null),对 SELF 主体不可见
    expect(body.items.map((i) => i.username)).toEqual(['made_by_scoped']);
    expect(body.total).toBe(1);
  });

  it('should_return_404_for_others_row_when_actor_scope_is_self', async () => {
    // 这条是关键: 列表里看不见,但知道 id 能不能直接读出来?
    const res = await authed(t.app, t.scopedToken)(`/users/${t.viewerId}`);

    // 404 而不是 403 —— 403 等于承认这条记录存在
    expect(res.status).toBe(404);
  });

  it('should_reject_update_of_others_row_when_actor_scope_is_self', async () => {
    const res = await postJson(t.app, t.scopedToken, `/users/${t.viewerId}/update`, {
      displayName: '被越权改名',
      status: 'ACTIVE',
      roleIds: [],
    });

    expect(res.status).toBe(404);
  });

  it('should_reject_delete_of_others_row_when_actor_scope_is_self', async () => {
    const res = await postJson(t.app, t.scopedToken, `/users/${t.viewerId}/delete`, {});

    expect(res.status).toBe(404);
  });

  it('should_reject_reset_password_of_others_row_when_actor_scope_is_self', async () => {
    const res = await postJson(t.app, t.scopedToken, `/users/${t.viewerId}/reset-password`, {
      newPassword: 'brand-new-pass-1',
    });

    expect(res.status).toBe(404);
  });

  it('should_allow_full_access_when_actor_scope_is_all', async () => {
    // 反向验证:上面那组 404 不是"scoped 用户什么都访问不了"的假绿
    const res = await authed(t.app, t.adminToken)(`/users/${t.viewerId}`);
    expect(res.status).toBe(200);
  });
});
