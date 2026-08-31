/**
 * 会话仓储端口。
 *
 * 这是全站最热的读路径 —— 每个受保护请求都要查一次,所以
 * findPrincipalByTokenHash 必须是一次 join 拿完,不能查三遍。
 */

import type { Session, SessionPrincipal } from './auth.types.js';

export interface SessionRepository {
  create(session: Session): Promise<void>;

  /**
   * 按 tokenHash 精确命中唯一索引,一次带出 session + user + roles + permissions 四层。
   *
   * [重要] 这里**不做过期过滤** —— 过期判定伴随"删除该行"的副作用,属于业务规则,
   * 留给 Service 处理。仓储只负责取数据。
   *
   * 未命中返回 null,不抛异常。
   */
  findPrincipalByTokenHash(tokenHash: string): Promise<SessionPrincipal | null>;

  /**
   * 滑动续期。只更新 lastSeenAt 与 expiresAt 两个字段。
   * 调用方会做时间节流(见 authenticate.service.ts),不要每请求都调。
   */
  touch(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void>;

  /** 按 token 删除单条(登出)。幂等:不存在也不抛。 */
  deleteByTokenHash(tokenHash: string): Promise<void>;

  /** 踢掉某用户全部会话。禁用用户、管理员重置密码时调用。 */
  deleteAllByUserId(userId: string): Promise<void>;

  /** 踢掉某用户除指定会话外的全部会话。用户自己改密码时调用(保留当前设备)。 */
  deleteOthersByUserId(userId: string, keepSessionId: string): Promise<void>;

  /** 清理已过期会话,返回删除条数。由定时任务周期调用,防止会话表无限增长。 */
  deleteExpired(now: Date): Promise<number>;
}
