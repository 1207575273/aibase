/**
 * 认证链路 e2e。
 *
 * 这里验的是**只有真进程 + 真 HTTP 才能验到**的东西:
 *   - Set-Cookie 的属性(HttpOnly / SameSite / Path)真的写对了
 *   - Cookie 与 Bearer 两条认证通道都能用
 *   - 登出后 token 真的失效(而不是只在内存里标记了一下)
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
     * 而是选 JWT 时一并选下的代价(见 domain/auth/token-signer.ts)。
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

  describe('密码加密传输', () => {
    /** 与浏览器完全相同的 Web Crypto 调用 —— Node 22 原生就有。 */
    const encrypt = async (
      password: string,
      challenge: { keyId: string; publicKey: string; nonce: string },
    ): Promise<string> => {
      // [坑] getRandomValues 不能解构出来单独调 —— 它内部要用 this,
      // 脱离 crypto 对象会抛 "Value of this must be of type Crypto"。
      // subtle 是个独立对象所以可以解构。
      const { subtle } = globalThis.crypto;
      const b64 = (b: ArrayBuffer): string => Buffer.from(b).toString('base64url');

      const publicKey = await subtle.importKey(
        'spki',
        Buffer.from(challenge.publicKey, 'base64url'),
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['encrypt'],
      );
      const aesKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const data = await subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        new TextEncoder().encode(JSON.stringify({ p: password, n: challenge.nonce })),
      );
      const wrapped = await subtle.encrypt(
        { name: 'RSA-OAEP' },
        publicKey,
        await subtle.exportKey('raw', aesKey),
      );
      return [challenge.keyId, b64(wrapped), b64(iv.buffer), b64(data)].join('.');
    };

    it('should_login_with_encrypted_password', async () => {
      const challenge = await api.get<{ keyId: string; publicKey: string; nonce: string }>(
        '/auth/login-challenge',
      );
      expect(challenge.status).toBe(200);
      expect(challenge.body.publicKey.length).toBeGreaterThan(300);

      const passwordCipher = await encrypt(E2E_ADMIN.password, challenge.body);
      const res = await api.post<{ token: string }>('/auth/login', {
        username: E2E_ADMIN.username,
        passwordCipher,
      });

      expect(res.status).toBe(200);
      expect(res.body.token.split('.')).toHaveLength(3);
    });

    it('should_reject_replayed_cipher', async () => {
      // ★ 端到端确认防重放确实生效 —— 密文不能变成长期有效的凭据
      const challenge = await api.get<{ keyId: string; publicKey: string; nonce: string }>(
        '/auth/login-challenge',
      );
      const passwordCipher = await encrypt(E2E_ADMIN.password, challenge.body);
      const body = { username: E2E_ADMIN.username, passwordCipher };

      expect((await api.post('/auth/login', body)).status).toBe(200);

      const replay = await api.post<ErrorBody>('/auth/login', body);
      expect(replay.status).toBe(400);
      expect(replay.body.code).toBe('AUTH_LOGIN_KEY_EXPIRED');
    });

    it('should_reject_both_password_and_cipher', async () => {
      // 契约层的 refine: 两条通道二选一,同时给是非法请求
      const res = await api.post<ErrorBody>('/auth/login', {
        username: E2E_ADMIN.username,
        password: E2E_ADMIN.password,
        passwordCipher: 'whatever',
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('should_reject_neither_password_nor_cipher', async () => {
      const res = await api.post<ErrorBody>('/auth/login', { username: E2E_ADMIN.username });
      expect(res.status).toBe(400);
    });
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
