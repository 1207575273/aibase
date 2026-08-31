/**
 * 全系统唯一的错误类型。
 *
 * 干什么: 承载「业务上出了什么事」+「HTTP 上该回什么码」,由 interface 层的
 *         app.onError 统一翻译成响应体。
 * 解决什么问题:
 * - 姊妹项目 work_nm_tp 有 **6 套并存的错误类型**(DomainError 家族 / AppError /
 *   TaskAppError / AgentAppError / ChatSessionAppError / WebToolError),其中只有一个
 *   继承了公共基类,导致 interface 层必须按具体类 instanceof 分流,同一个 404
 *   有好几条完全不同的产生路径。更糟的是它 domain/shared/errors.ts 里那个"共享"的
 *   ErrorCode 闭合联合里全是 WORKFLOW_*,NotFoundError 的默认码直接写死
 *   'WORKFLOW_NOT_FOUND' —— 名为 shared 实为某个业务域的私货。
 * - **httpStatus 直接挂在错误上**,而不是在 interface 层维护一张 code -> status 映射表。
 *   姊妹项目那张表被复制了 11 份且已经互相漂移,其中一份的默认分支是 400 ——
 *   意味着任何未登记的错误码都被当成"用户参数错",真正的内部故障被静默降级,
 *   监控完全看不见。挂在错误上就不存在"忘了登记"这件事。
 *
 * 用法: 不要直接 new,用下面的工厂函数 —— 它们保证了 code 与 status 的搭配是对的。
 */

/** 错误码。各域在自己的 errors.ts 里用 as const 定义,拼错由编译器兜住。 */
export type ErrorCode = string;

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 资源不存在。语义上是"你要的东西不在",不是"你没权限看"。 */
export const notFound = (code: ErrorCode, message: string, details?: unknown): AppError =>
  new AppError(code, message, 404, details);

/**
 * 状态冲突:唯一约束撞了、当前状态不允许这个操作、资源仍被引用。
 * 与 400 的区别:400 是"你发的数据格式不对",409 是"数据没问题但现在做不了"。
 */
export const conflict = (code: ErrorCode, message: string, details?: unknown): AppError =>
  new AppError(code, message, 409, details);

/** 业务规则校验失败。纯格式问题由 zod 在路由层拦掉,走不到这里。 */
export const invalid = (code: ErrorCode, message: string, details?: unknown): AppError =>
  new AppError(code, message, 400, details);

/** 未登录 / token 失效 / 已过期。前端据此跳登录页。 */
export const unauthenticated = (
  message = '未登录或登录已失效',
  code: ErrorCode = 'UNAUTHENTICATED',
): AppError => new AppError(code, message, 401);

/**
 * 已登录但不允许做这件事。
 * [重要] 与 401 的区别决定了前端行为:401 跳登录页,403 只提示"无权限"不跳转。
 * 跳错了会让一个没权限的用户陷入"登录 -> 被踢 -> 再登录"的死循环。
 */
export const forbidden = (message: string, details?: unknown): AppError =>
  new AppError('FORBIDDEN', message, 403, details);

/** 请求过于频繁。 */
export const tooManyRequests = (code: ErrorCode, message: string): AppError =>
  new AppError(code, message, 429);

/**
 * 服务端自己的问题(装配错误、不该发生的分支)。
 * 响应体不会带具体 message —— 内部细节不外泄,详情只进日志。
 */
export const internal = (message: string, details?: unknown): AppError =>
  new AppError('INTERNAL_ERROR', message, 500, details);

/**
 * 「查不到就抛 404」的样板收敛。
 *
 * 姊妹项目 application 层有 69 处手写的「取实体 -> 判 null -> throw」,
 * 每处 4 行,全是仪式。这个助手把它压成一行。
 *
 * @example
 * const person = await mustFind(() => repo.findById(id), PERSON_ERROR.NOT_FOUND, `人员 ${id} 不存在`);
 */
export const mustFind = async <T>(
  find: () => Promise<T | null>,
  code: ErrorCode,
  message: string,
): Promise<T> => {
  const found = await find();
  if (found === null) throw notFound(code, message);
  return found;
};
