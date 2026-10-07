/**
 * 全站唯一的错误出口,挂在 app.onError 上。
 *
 * 干什么: 把任何抛到路由外面的异常翻译成统一形状的 JSON 响应。
 *
 * 解决什么问题:
 *   曾见过的一个项目把这套逻辑**复制了 11 份**(每个路由文件一个私有 handleError),
 *   而且已经互相漂移:有的兜底 500、有的兜底 400、有的不认 ZodError。
 *   最严重的一份用 12 层三元表达式串成 code->status 映射,默认分支是 400 ——
 *   意味着任何未登记的错误码都被当成"用户参数错",**真正的内部故障被静默降级,
 *   监控完全看不见**。
 *   它的 211 个路由 handler 每一个都写着同样的 try/catch。
 *
 *   本模板只有这一份,路由 handler 里**不写 try/catch**,只写 happy path。
 *   Hono 会把 handler 抛出的异常(含 async 的 rejection)自动送到这里。
 */

import type { ErrorResponse } from '@app/contracts';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { AppError } from '../../lib/app-error.js';
import type { AppEnv } from './env.js';

/**
 * Hono 内建中间件抛出的 HTTPException 到业务错误码的映射。
 *
 * 为什么需要: Hono 的一些内建中间件(bodyLimit、basicAuth 等)会抛 HTTPException
 * 并自带一个纯文本 Response。不处理的话它会掉进"未知异常"分支变成 **500** ——
 * 一个"请求体太大"的用户错误被报成服务端故障,既误导用户也污染错误监控。
 * (实测: bodyLimit 触发时返回的是 500 而不是 413。)
 */
const HTTP_EXCEPTION_CODES: Record<number, string> = {
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  431: 'HEADERS_TOO_LARGE',
};

/** zod 校验失败的统一错误码。前端据此渲染表单字段级错误。 */
export const VALIDATION_ERROR_CODE = 'VALIDATION_FAILED';

/** 把 zod 的 issues 压成前端好用的形状: 字段路径 -> 错误消息。 */
const toFieldErrors = (err: ZodError): Array<{ field: string; message: string }> =>
  err.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));

export const handleError = (err: Error, c: Context<AppEnv>): Response => {
  const traceId = c.get('traceId') ?? 'unknown';
  const logger = c.get('logger');

  if (err instanceof AppError) {
    const body: ErrorResponse = {
      code: err.code,
      message: err.message,
      traceId,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
    // 5xx 是服务端的问题,必须进日志;4xx 是用户输入问题,debug 级别即可,
    // 否则一个前端表单校验失败就刷一条 error 日志,真正的故障会被淹没。
    if (err.httpStatus >= 500) {
      logger?.error(err.message, { code: err.code, err });
    } else {
      logger?.debug('业务错误', { code: err.code, message: err.message });
    }
    return c.json(body, err.httpStatus as ContentfulStatusCode);
  }

  if (err instanceof ZodError) {
    const body: ErrorResponse = {
      code: VALIDATION_ERROR_CODE,
      message: '参数校验失败',
      details: { fields: toFieldErrors(err) },
      traceId,
    };
    logger?.debug('参数校验失败', { fields: toFieldErrors(err) });
    return c.json(body, 400);
  }

  // Hono 内建中间件抛的异常。转成统一形状,不让它以自己的纯文本格式返回 ——
  // 全站只有一种错误响应形状,前端才不用写第二套解析逻辑。
  if (err instanceof HTTPException) {
    const body: ErrorResponse = {
      code: HTTP_EXCEPTION_CODES[err.status] ?? 'REQUEST_REJECTED',
      message: err.status === 413 ? '请求体过大' : (err.message || '请求被拒绝'),
      traceId,
    };
    logger?.warn('请求被中间件拒绝', { status: err.status, path: c.req.path });
    return c.json(body, err.status);
  }

  // 到这里就是没预料到的异常。
  // [安全] 响应体里**不放** err.message —— 内部细节(SQL 片段、文件路径、
  // 依赖库的报错)不能泄漏给客户端。详情只进日志,用户拿 traceId 来问。
  logger?.error('未处理异常', { err });
  const body: ErrorResponse = {
    code: 'INTERNAL_ERROR',
    message: '服务内部错误,请联系管理员并提供 traceId',
    traceId,
  };
  return c.json(body, 500);
};

/** 404 兜底。与错误响应同形,前端不需要为"接口不存在"写特殊分支。 */
export const handleNotFound = (c: Context<AppEnv>): Response => {
  const body: ErrorResponse = {
    code: 'ROUTE_NOT_FOUND',
    message: `接口不存在: ${c.req.method} ${c.req.path}`,
    traceId: c.get('traceId') ?? 'unknown',
  };
  return c.json(body, 404);
};
