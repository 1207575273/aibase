/**
 * Cookie Secure 策略的单测。
 *
 * 为什么值得专门测:这条规则错了不会报错,只会让**整个系统登不进去** ——
 * 登录返回 200、响应里有 Set-Cookie,但浏览器把它丢了,下一个请求 401。
 * 排查时所有线索都指向"认证坏了",实际是 Cookie 根本没存下来。
 * 内网 HTTP 部署真实踩过这个坑。
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { isSecureRequest, resolveCookieSecure, type CookieSecureMode } from './request-proto.js';

/** 起一个最小 app,把探测结果作为响应体返回,这样能走真实的 Hono Context。 */
const probe = async (
  url: string,
  headers: Record<string, string> = {},
  mode: CookieSecureMode = 'auto',
): Promise<{ secureRequest: boolean; cookieSecure: boolean }> => {
  const app = new Hono();
  app.get('/probe', (c) =>
    c.json({
      secureRequest: isSecureRequest(c),
      cookieSecure: resolveCookieSecure(mode, c),
    }),
  );
  const res = await app.request(url, { headers });
  return (await res.json()) as { secureRequest: boolean; cookieSecure: boolean };
};

describe('isSecureRequest', () => {
  it('should_be_false_when_plain_http', async () => {
    // 内网部署的典型形态 —— 这一条为 true 就等于系统登不进去
    const r = await probe('http://192.168.160.98:7001/probe');
    expect(r.secureRequest).toBe(false);
  });

  it('should_be_true_when_https', async () => {
    const r = await probe('https://app.example.com/probe');
    expect(r.secureRequest).toBe(true);
  });

  it('should_be_true_when_proxy_forwards_https', async () => {
    // nginx 终止 TLS 后以明文转发给后端:URL 是 http,但对浏览器那一跳是 https
    const r = await probe('http://127.0.0.1:7001/probe', { 'x-forwarded-proto': 'https' });
    expect(r.secureRequest).toBe(true);
  });

  it('should_read_first_hop_when_forwarded_proto_is_chained', async () => {
    // 多级代理会拼成 'https, http';首段才是最靠近客户端的那一跳
    const r = await probe('http://127.0.0.1:7001/probe', { 'x-forwarded-proto': 'https, http' });
    expect(r.secureRequest).toBe(true);
  });

  it('should_be_false_when_proxy_forwards_http', async () => {
    const r = await probe('http://127.0.0.1:7001/probe', { 'x-forwarded-proto': 'http' });
    expect(r.secureRequest).toBe(false);
  });

  it('should_ignore_case_of_forwarded_proto', async () => {
    const r = await probe('http://127.0.0.1:7001/probe', { 'x-forwarded-proto': 'HTTPS' });
    expect(r.secureRequest).toBe(true);
  });

  it('should_fall_back_to_url_when_forwarded_proto_is_empty', async () => {
    // 有些代理会发一个空值的头,不能因此判成 http 而丢掉 https 的事实
    const r = await probe('https://app.example.com/probe', { 'x-forwarded-proto': '' });
    expect(r.secureRequest).toBe(true);
  });
});

describe('resolveCookieSecure', () => {
  it('should_not_set_secure_when_auto_and_plain_http', async () => {
    // 这就是要根治的那个 bug:内网 HTTP 下绝不能加 Secure
    const r = await probe('http://192.168.160.98:7001/probe', {}, 'auto');
    expect(r.cookieSecure).toBe(false);
  });

  it('should_set_secure_when_auto_and_https', async () => {
    // 反过来也不能松:真的是 HTTPS 就必须加上,否则 Cookie 会在明文里裸奔
    const r = await probe('https://app.example.com/probe', {}, 'auto');
    expect(r.cookieSecure).toBe(true);
  });

  it('should_set_secure_when_auto_and_behind_tls_proxy', async () => {
    const r = await probe('http://127.0.0.1:7001/probe', { 'x-forwarded-proto': 'https' }, 'auto');
    expect(r.cookieSecure).toBe(true);
  });

  it('should_always_set_secure_when_mode_is_always', async () => {
    // 代理没转发 X-Forwarded-Proto 时的兜底开关
    const r = await probe('http://127.0.0.1:7001/probe', {}, 'always');
    expect(r.cookieSecure).toBe(true);
  });

  it('should_never_set_secure_when_mode_is_never', async () => {
    const r = await probe('https://app.example.com/probe', {}, 'never');
    expect(r.cookieSecure).toBe(false);
  });
});
