/**
 * 认证链路 e2e。
 *
 * 这里验的是**只有真进程 + 真 HTTP 才能验到**的东西:
 *   - 登录响应里确实**没有** Set-Cookie(反向护栏,见下方用例)
 *   - Bearer 令牌在真实网络往返下能用
 *   - 错误响应的形状、状态码在经过 Node HTTP 层之后仍然正确
 */

import { describe, expect, it } from 'vitest';
import { api, login } from './client.js';
import { E2E_ADMIN } from './global-setup.js';

interface MeBody {
  user: { username: string };
  superAdmin: boolean;
  permissions: string[];
}

interface ErrorBody {
  code: string;
  message: string;
  traceId: string;
}

describe('认证链路', () => {
  it('should_reject_login_with_wrong_password', async () => {
    const res = await api.post<ErrorBody>('/auth/login', {
      username: E2E_ADMIN.username,
      password: 'definitely-wrong',
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('should_return_same_error_for_unknown_user', async () => {
    // [安全] 用户不存在与密码错误必须不可区分 —— 区分开就等于提供了用户名枚举接口
    const res = await api.post<ErrorBody>('/auth/login', {
      username: 'no-such-person',
      password: 'whatever-long-enough',
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('should_not_set_any_cookie_on_login', async () => {
    // 登录态完全不走 Cookie 了。这条断言是**反向护栏**:
    // 哪天有人为了"顺手"又加回 setCookie,CSRF、Secure 标志、SameSite、Path
    // 那一整类部署期问题会跟着回来,而它们的症状全是"某某环境登不上",极难定位。
    const { setCookie } = await login(E2E_ADMIN.username, E2E_ADMIN.password);
    expect(setCookie).toBeNull();
  });

  it('should_authenticate_via_bearer_token', async () => {
    // 浏览器与 curl 走的是同一条通道 —— 令牌显式放进 Authorization 头
    const { token } = await login(E2E_ADMIN.username, E2E_ADMIN.password);

    const res = await api.get<MeBody>('/auth/me', { token });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe(E2E_ADMIN.username);
  });

  it('should_return_jwt_shaped_token', async () => {
    // JWT 是三段 base64url。形状错了说明签发路径被换掉了
    const { token } = await login(E2E_ADMIN.username, E2E_ADMIN.password);
    expect(token.split('.')).toHaveLength(3);
  });

  it('should_expose_token_expiry_header', async () => {
    // 前端靠这个头提前引导重新登录,而不是等某个请求突然 401 打断用户
    const { token } = await login(E2E_ADMIN.username, E2E_ADMIN.password);
    const res = await api.get<MeBody>('/auth/me', { token });

    const exp = res.headers.get('x-token-expires-at');
    expect(exp).toBeTruthy();
    expect(Number.isNaN(new Date(exp ?? '').getTime())).toBe(false);
  });

  it('should_keep_token_valid_after_logout', async () => {
    /*
     * [有意如此] 登出**不会**让令牌失效。
     *
     * JWT 是自验证的,服务端没有可吊销的对象。真正的登出发生在前端:
     * 把本地存的令牌删掉。这条用例把这个事实钉死 —— 它不是 bug,
     * 而是选 JWT 时一并选下的代价(见 server/src/modules/identity/domain/token-signer.ts)。
     *
     * 哪天这条变红了,说明有人加了服务端吊销机制。那本身可能是对的改动,
     * 但要意识到:每请求查一次吊销表,就等于绕回了会话方案。
     */
    const { token } = await login(E2E_ADMIN.username, E2E_ADMIN.password);

    const out = await api.post('/auth/logout', {}, { token });
    expect(out.status).toBe(200);

    const after = await api.get<MeBody>('/auth/me', { token });
    expect(after.status).toBe(200);
  });

  it('should_be_idempotent_on_repeated_logout', async () => {
    const { token } = await login(E2E_ADMIN.username, E2E_ADMIN.password);

    for (let i = 0; i < 3; i += 1) {
      const res = await api.post('/auth/logout', {}, { token });
      expect(res.status).toBe(200);
    }
  });

  it('should_include_traceid_in_every_error_response', async () => {
    const res = await api.get<ErrorBody>('/users');
    expect(res.status).toBe(401);
    // traceId 是用户报障时唯一能定位到服务端日志的东西,每个错误响应都必须有
    expect(res.body.traceId).toMatch(/^[\w-]+$/);
    expect(res.headers.get('x-request-id')).toBe(res.body.traceId);
  });

  it('should_reject_login_without_password', async () => {
    const res = await api.post<ErrorBody>('/auth/login', { username: E2E_ADMIN.username });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('should_expose_permission_catalog_from_code_constants', async () => {
    const { token } = await login(E2E_ADMIN.username, E2E_ADMIN.password);
    const res = await api.get<{ items: Array<{ group: string; items: unknown[] }> }>(
      '/auth/permission-catalog',
      { token },
    );

    expect(res.status).toBe(200);
    // 权限目录直接从代码常量导出,不查库 —— 加一个权限码这里自动就多一项
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.some((g) => g.group === '系统管理')).toBe(true);
  });
});
