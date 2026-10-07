/**
 * 应用级回归测试 —— 重点是**默认拒绝**。
 *
 * 这个文件里最值钱的是 should_require_auth_for_every_non_public_route:
 * 它遍历所有已注册的路由,逐个发匿名请求,断言除公开区外全部返回 401。
 *
 * 为什么必须有: 整套「受保护路由挂在 secured 子 app 上」的设计,
 * 靠的是"记得挂对位置"这一条约定。有人把新路由挂到 app 根上,接口就裸奔了,
 * 而且**不报任何错、测试照样绿、code review 也未必看得出来**。
 * 这 30 行是整个默认拒绝设计里性价比最高的代码 —— 没有它,default-deny 只是口号。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTHENTICATED_ONLY_PATHS, PUBLIC_PATHS } from './app.js';
import { authed, setupTestApp, type TestApp } from '../../tests/helpers/test-app.js';

describe('buildApp', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await setupTestApp();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it('should_report_healthy_when_db_is_up', async () => {
    const res = await t.app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db: string };
    expect(body.status).toBe('ok');
    expect(body.db).toBe('up');
  });

  it('should_return_traceid_header_on_every_response', async () => {
    const res = await t.app.request('/health');
    // traceId 必须回写,否则用户报障时拿不到关联日志的钥匙
    expect(res.headers.get('x-request-id')).toMatch(/^[\w-]{8,}$/);
  });

  it('should_reuse_upstream_request_id_when_provided', async () => {
    const res = await t.app.request('/health', {
      headers: { 'x-request-id': 'upstream-trace-1' },
    });
    // 沿用上游 id,让一次调用在多个服务里的日志能串起来
    expect(res.headers.get('x-request-id')).toBe('upstream-trace-1');
  });

  it('should_ignore_upstream_request_id_when_format_is_unexpected', async () => {
    // 带空格的值在 HTTP 上合法,但不符合我们的 traceId 格式约定。
    // 应丢弃并自己生成,而不是原样透传 —— 上游可控的值直接进日志有注入风险。
    const res = await t.app.request('/health', {
      headers: { 'x-request-id': 'has spaces and ; semicolons' },
    });
    const traceId = res.headers.get('x-request-id');
    expect(traceId).not.toBe('has spaces and ; semicolons');
    expect(traceId).toMatch(/^[\w-]+$/);
  });

  it('should_ignore_overlong_upstream_request_id', async () => {
    const res = await t.app.request('/health', {
      headers: { 'x-request-id': 'a'.repeat(500) },
    });
    expect((res.headers.get('x-request-id') ?? '').length).toBeLessThanOrEqual(64);
  });

  /**
   * 匿名访问不存在的路径返回 401 而不是 404 —— 这是**有意的行为**。
   *
   * 原因: 受保护区通过 secured.use('*', authenticate) 挂载,会拦下所有未匹配路径,
   * 于是未登录者无法通过"404 还是 401"的差异探测系统里有哪些接口存在。
   * 已登录用户访问不存在的路径则正常拿到 404(见下一个用例)。
   *
   * 这个用例把行为固化下来,免得后来者当成 bug"修"掉,反而打开枚举面。
   */
  it('should_return_401_not_404_for_unknown_route_when_anonymous', async () => {
    const res = await t.app.request('/no-such-endpoint');
    expect(res.status).toBe(401);
  });

  it('should_return_unified_error_shape_for_unknown_route_when_authenticated', async () => {
    const res = await authed(t.app, t.adminToken)('/no-such-endpoint');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; traceId: string };
    expect(body.code).toBe('ROUTE_NOT_FOUND');
    // 404 也带 traceId —— 前端不需要为它写特殊分支
    expect(body.traceId).toBeTruthy();
  });

  /**
   * ★ 默认拒绝回归。整个文件的核心。
   */
  it('should_require_auth_for_every_non_public_route', async () => {
    const publicPaths = new Set<string>(PUBLIC_PATHS);

    // 从 Hono 拿实际注册的全部路由 —— 不是手工维护的清单,
    // 所以新增路由会自动被纳入检查,不存在"忘了加进清单"。
    const routes = t.app.routes.filter((r) => r.method !== 'ALL' && !r.path.includes('*'));
    expect(routes.length).toBeGreaterThan(5);

    const leaked: string[] = [];

    for (const route of routes) {
      if (publicPaths.has(route.path)) continue;

      // :id 这类参数占位换成具体值,才能真正发出请求
      const path = route.path.replace(/:[^/]+/g, 'probe-id');

      const res = await t.app.request(path, {
        method: route.method,
        // 带一个合法 JSON body,免得被 400 挡在鉴权之前 —— 那样就测不出有没有鉴权了
        ...(route.method === 'POST'
          ? { headers: { 'Content-Type': 'application/json' }, body: '{}' }
          : {}),
      });

      // 401 = 正确拒绝。其他任何状态都说明这个端点没有认证保护:
      // 200 显然是裸奔;400 说明请求先过了校验才被拦,意味着 validate
      // 排在了 authenticate 前面(信息泄漏面小一些但仍是错的)。
      if (res.status !== 401) {
        leaked.push(`${route.method} ${route.path} -> ${res.status}`);
      }
    }

    expect(
      leaked,
      `以下端点缺少认证保护(应挂到 secured 子 app 上):\n${leaked.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * ★ 授权回归。与上面那条默认拒绝是**一对**,缺一不可。
   *
   * 上面那条守的是"忘了挂 authenticate"(接口对匿名裸奔);
   * 这条守的是"忘了挂 requirePermission"(接口对任何登录用户裸奔)。
   *
   * 后者更容易发生: requirePermission 是**逐路由**挂的,漏一个不会报任何错、
   * 测试照样绿、code review 也未必看得出来 —— 症状要等到某个只读用户
   * 把别人的数据删了才暴露。
   *
   * 做法与上面对称: 用一个零权限账号遍历所有已注册路由,断言全部 403。
   * 例外只有 AUTHENTICATED_ONLY_PATHS 里那几条,它们是有意不挂的。
   */
  it('should_require_permission_for_every_secured_route', async () => {
    const exempt = new Set<string>([...PUBLIC_PATHS, ...AUTHENTICATED_ONLY_PATHS]);

    const routes = t.app.routes.filter((r) => r.method !== 'ALL' && !r.path.includes('*'));
    const leaked: string[] = [];

    for (const route of routes) {
      if (exempt.has(route.path)) continue;

      const path = route.path.replace(/:[^/]+/g, 'probe-id');

      const res = await authed(t.app, t.nobodyToken)(path, {
        method: route.method,
        ...(route.method === 'POST' ? { body: '{}' } : {}),
      });

      /*
       * 403 = 正确拒绝(已登录但无权限)。
       *
       * 其他状态都说明这个端点没有权限码保护:
       *   200 显然是裸奔;
       *   400 说明 validate 排在了 requirePermission 前面 —— 一个没权限的人
       *       能通过错误信息的差异探测出参数结构,而且鉴权发生在解析之后;
       *   404 说明它先查了数据库才拒绝 —— 同样是鉴权太晚。
       */
      if (res.status !== 403) {
        leaked.push(`${route.method} ${route.path} -> ${res.status}`);
      }
    }

    expect(
      leaked,
      `以下端点缺少权限码保护(应挂 requirePermission,或登记进 AUTHENTICATED_ONLY_PATHS):\n${leaked.join('\n')}`,
    ).toEqual([]);
  });

  it('should_allow_authenticated_only_routes_without_any_permission', async () => {
    // 反向验证:上面那条不是"零权限账号访问什么都是 403"的假绿。
    // /auth/me 每个登录用户都必须能调,否则前端进不了首页。
    const res = await authed(t.app, t.nobodyToken)('/auth/me');
    expect(res.status).toBe(200);
  });

  it('should_allow_public_routes_without_auth', async () => {
    // 反向验证:公开区确实不需要登录,否则上面那条可能是"全都 401"的假绿
    expect((await t.app.request('/health')).status).toBe(200);
    expect((await t.app.request('/version')).status).toBe(200);

    // 登录端点能收到请求。密码错也是 401,但 code 与"未认证"不同 ——
    // 用 code 区分,确保它真的走到了登录逻辑而不是被认证中间件拦下。
    const res = await t.app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'whatever-long-enough' }),
    });
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('should_reject_oversized_body_with_413', async () => {
    const huge = JSON.stringify({ username: 'a'.repeat(2 * 1024 * 1024), password: 'b' });
    const res = await t.app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: huge,
    });
    // 413 而不是 500 —— Hono 的 bodyLimit 抛 HTTPException,
    // handle-error 必须认识它,否则用户错误会被报成服务端故障
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; traceId: string };
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
    // 即使是中间件拒绝,响应形状也要与业务错误一致
    expect(body.traceId).toBeTruthy();
  });
});
