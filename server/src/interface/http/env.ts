/**
 * Hono 的 Context 变量类型声明。
 *
 * 干什么: 声明中间件往 c.set() 里放了什么,让 c.get() 有类型。
 * 解决什么问题: 不声明的话 c.get('actor') 返回 any,主体信息一进业务代码就失去类型 ——
 *   拼错 key 也不报错。
 */

import type { Context } from 'hono';
import type { ActorContext } from '../../domain/auth/actor.js';
import type { Logger } from '../../domain/shared/logger.js';
import { internal } from '../../domain/shared/app-error.js';

export interface AppEnv {
  Variables: {
    /** 本次请求的追踪 id。由 requestContext 中间件生成,全局可用。 */
    traceId: string;
    /** 已绑定 traceId 的子 logger。 */
    logger: Logger;
    /** 当前主体。只有经过 authenticate 中间件的路由才有。 */
    actor?: ActorContext;
    /** 当前会话 id。改密时用来保留当前设备。 */
    sessionId?: string;
  };
}

export type AppContext = Context<AppEnv>;

/**
 * 取当前主体。
 *
 * 受保护区的路由一定经过 authenticate 中间件,所以这里拿不到 actor
 * 只可能是**装配错误**(路由挂错了位置),不是用户的错 —— 所以抛 500 而不是 401。
 * 这个区分很重要:返 401 会让一个装配 bug 伪装成"用户没登录",排查方向直接跑偏。
 */
export const getActor = (c: AppContext): ActorContext => {
  const actor = c.get('actor');
  if (actor === undefined) {
    throw internal('路由未挂载 authenticate 中间件,拿不到当前主体');
  }
  return actor;
};

export const getSessionId = (c: AppContext): string => {
  const sessionId = c.get('sessionId');
  if (sessionId === undefined) {
    throw internal('路由未挂载 authenticate 中间件,拿不到会话 id');
  }
  return sessionId;
};
