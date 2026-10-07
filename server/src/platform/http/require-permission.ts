/**
 * 鉴权中间件 —— 声明「调这个接口需要什么权限」。
 *
 * 用法(挂在单个路由上):
 * ```ts
 * app.get('/', requirePermission('person:read'), (c) => ...);
 * app.post('/create', requirePermission('person:create'), (c) => ...);
 * ```
 *
 * 为什么逐路由挂而不是按前缀批量挂:
 *   前缀挂载(app.use('/persons/*', requirePermission('person:read')))会让
 *   "这个端点到底要什么权限"没法在 handler 那一行读出来,而且读写权限没法区分。
 *   逐路由挂多写一点,换来的是**看代码即看权限清单**。
 *
 * [类型安全] 参数类型是 PermissionCode 联合而不是 string ——
 *   requirePermission('person:creat') 这种拼写错误是编译错误,
 *   而不是运行期的"这个接口谁都能调"。
 */

import type { PermissionCode } from '@app/contracts';
import type { MiddlewareHandler } from 'hono';
import { hasPermission } from '../../lib/actor.js';
import { forbidden } from '../../lib/app-error.js';
import { getActor, type AppEnv } from './env.js';

export const requirePermission = (code: PermissionCode): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const actor = getActor(c);
    if (!hasPermission(actor, code)) {
      // details 里带上缺的权限码,便于前端提示与排查 ——
      // "无权限"这三个字对用户和开发都没有信息量。
      throw forbidden('没有权限执行此操作', { required: code });
    }
    await next();
  };
};
