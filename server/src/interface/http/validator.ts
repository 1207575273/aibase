/**
 * zValidator 的封装 —— 让校验失败也走全站统一的错误出口。
 *
 * 干什么: 包一层 @hono/zod-validator,把它的默认错误响应换成「抛 ZodError」。
 *
 * 解决什么问题:
 *   zValidator 默认会**自己**返回一个响应,形状是
 *   `{ success: false, error: { name: 'ZodError', message: '<一大坨转义 JSON 字符串>' } }`
 *   —— 它绕过了 app.onError,于是全站有了两种错误响应格式:
 *   业务错误是 { code, message, traceId },校验错误是上面那坨。
 *   前端要为此写两套解析逻辑,而且那个 message 是把 issues 数组
 *   JSON.stringify 之后塞进字符串里的,前端还得再 parse 一次才能拿到字段级错误。
 *
 *   这个坑不测就发现不了 —— 类型是对的、编译通过、正常请求也正常,
 *   只有真发一个非法请求才会暴露。
 *
 * [约定] 路由里一律 import 本文件的 validate,不要直接用 zValidator。
 */

import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { ZodType } from 'zod';

/**
 * 声明式请求校验。
 *
 * @param target 校验哪一部分:'json' 请求体 / 'query' 查询参数 / 'param' 路径参数
 * @param schema 契约包里定义的 zod schema
 */
export const validate = <T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator(target, schema, (result) => {
    // 校验失败时直接抛出 zod 的原始错误,交给 app.onError 统一处理 ——
    // 那里会把它翻译成 { code: 'VALIDATION_FAILED', details: { fields: [...] }, traceId }。
    if (!result.success) throw result.error;
    return undefined;
  });
