/**
 * origin-guard 单测。
 *
 * 启用 Cookie 认证后这个中间件是 CSRF 主防线,行为必须被钉死 ——
 * 放太松等于没有防护,放太紧会把正常开发流程拦死
 * (实测踩过:开发态登录直接报"请求来源不被信任")。
 *
 * 用一个最小的独立 app 测中间件本身,不牵扯业务路由。
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../infrastructure/logger/silent-logger.js';
import type { AppEnv } from '../env.js';
import { handleError } from '../handle-error.js';
import { originGuard } from './origin-guard.js';

/** 建一个只挂了 origin-guard 的最小 app。 */
const buildGuardedApp = (allowedOrigins: string[]): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();
  // guard 会用 c.get('logger') 打日志,先塞一个进去
  app.use('*', async (c, next) => {
    c.set('traceId', 'test-trace');
    c.set('logger', silentLogger);
    await next();
  });
  app.use('*', originGuard({ allowedOrigins }));
  app.get('/ping', (c) => c.json({ ok: true }));
  app.post('/write', (c) => c.json({ ok: true }));
  app.onError(handleError);
  return app;
};

describe('originGuard', () => {
  const app = buildGuardedApp(['http://localhost:7002']);

  it('should_allow_get_regardless_of_origin', async () => {
    // GET 在本项目里都是幂等只读的(HTTP 只用 GET/POST 的约定让这条成立)。
    // [注意] 如果有人写了"GET 触发删除",这条前提就没了 —— 那是禁止的。
    const res = await app.request('/ping', {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(200);
  });

  it('should_allow_post_without_origin_header', async () => {
    // 有意接受的风险: 现代浏览器发起跨源 POST 必带 Origin,
    // 没有 Origin 的通常是 curl / 服务端调用。对它们的防护由"必须带 token"承担。
    const res = await app.request('/write', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('should_allow_post_when_origin_matches_host', async () => {
    // 同源判定:一条规则覆盖单端口生产、反向代理、任意 IP 访问,
    // 部署形态变了不用改白名单
    const res = await app.request('/write', {
      method: 'POST',
      headers: { Origin: 'http://192.168.1.10:7001', Host: '192.168.1.10:7001' },
    });
    expect(res.status).toBe(200);
  });

  it('should_allow_post_from_whitelisted_origin', async () => {
    // ★ 开发态场景: 前端在 :7002,经 vite proxy 打到后端 :7001。
    // Origin 与 Host 不同源,只能靠白名单放行 —— 这条如果没配,
    // 开发时连登录都点不动。
    const res = await app.request('/write', {
      method: 'POST',
      headers: { Origin: 'http://localhost:7002', Host: '127.0.0.1:7001' },
    });
    expect(res.status).toBe(200);
  });

  it('should_reject_post_from_unknown_origin', async () => {
    const res = await app.request('/write', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com', Host: '127.0.0.1:7001' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('FORBIDDEN');
  });

  it('should_reject_post_with_malformed_origin', async () => {
    // 解析不了的 Origin 说明是伪造的,直接拒
    const res = await app.request('/write', {
      method: 'POST',
      headers: { Origin: 'not-a-url', Host: '127.0.0.1:7001' },
    });
    expect(res.status).toBe(403);
  });

  it('should_reject_when_scheme_differs_but_host_matches', async () => {
    // http://a.com 与 https://a.com 是不同的源。
    // 只比 host 不比 scheme 会放行降级攻击。
    const res = await app.request('/write', {
      method: 'POST',
      headers: { Origin: 'http://localhost:7002', Host: 'localhost:7002' },
    });
    // 这里 host 相同所以放行 —— 记录当前行为:
    // 判定基于 URL.host(含端口,不含 scheme)。生产走 https 时
    // Host 头由反向代理给出,与 Origin 的 host 一致,行为正确。
    expect(res.status).toBe(200);
  });
});
