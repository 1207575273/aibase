/**
 * 请求上下文中间件 —— traceId + 子 logger + 访问日志。
 *
 * 干什么: 每个请求生成(或沿用)一个 traceId,派生一个绑定了它的 logger,
 *         请求结束时打一行访问日志,并把 traceId 回写到响应头。
 *
 * 解决什么问题:
 *   姊妹项目 work_nm_tp 的契约里声明了 ErrorResponse.traceId,
 *   注释直言"后端目前没有任何路由填过它";前端拦截器的注释也写着要处理 traceId,
 *   同样没实现。结果是线上一条 500,**没有任何办法把用户报的错关联到服务端日志**。
 *   它全仓的 app.use 只出现过两次。
 *
 *   有了这个中间件:用户报障时报出 traceId,直接 grep 日志就能拿到那次请求的全部记录 ——
 *   包括业务日志、错误堆栈、耗时。
 *
 * [顺序] 必须挂在**所有**中间件和路由之前 —— 后面的一切都依赖 c.get('logger')。
 */

import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from '../../../domain/shared/logger.js';
import type { AppEnv } from '../env.js';

/**
 * 上游(nginx / 网关 / 前端)传下来的追踪 id 头。
 * 沿用而不是重新生成,这样一次调用在多个服务里的日志能串起来。
 */
const REQUEST_ID_HEADER = 'x-request-id';

/** 不打访问日志的路径。健康检查每几秒一次,打了只会淹没真正的请求。 */
const SILENT_PATHS = new Set(['/health', '/api/health']);

export const requestContext = (rootLogger: Logger): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    // 上游给的值要防注入:限制长度和字符集,免得有人塞一个换行进来污染日志格式。
    const traceId =
      incoming !== undefined && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();

    c.set('traceId', traceId);
    c.set('logger', rootLogger.child({ traceId }));
    // 回写响应头:前端可以在报障时把它一并提供,不需要用户去翻控制台。
    c.header(REQUEST_ID_HEADER, traceId);

    const startedAt = Date.now();
    try {
      await next();
    } finally {
      // 放在 finally 里:即使 handler 抛异常(错误响应由 onError 生成),
      // 这行访问日志也一定会打出来。
      if (!SILENT_PATHS.has(c.req.path)) {
        const status = c.res.status;
        const meta = {
          method: c.req.method,
          path: c.req.path,
          status,
          durationMs: Date.now() - startedAt,
          actorId: c.get('actor')?.actorId,
        };
        // 按状态码分级:5xx 用 warn(错误详情已由 onError 打过 error),
        // 其余 info。这样 grep warn 以上就能看到所有异常请求。
        const log = c.get('logger');
        if (status >= 500) log.warn('请求异常', meta);
        else log.info('请求', meta);
      }
    }
  };
};
