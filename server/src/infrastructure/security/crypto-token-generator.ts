/**
 * 会话 token 生成器 —— node:crypto,零依赖。
 *
 * 设计要点:
 * - 256 bit 随机熵。不可预测、不可枚举。
 * - 存库前过一次 sha256。库被拖走也拿不到可用的 token。
 * - **不对 token 做加盐拉伸(scrypt/bcrypt)** —— 那是给低熵密码用的。
 *   token 是 256 位高熵随机串,不存在字典攻击面,sha256 足够且快。
 *   这一点很重要:每个请求都要算一次 hash,用 scrypt 的话每个请求就多 150ms。
 * - 查找走 `where: { tokenHash }` 等值命中唯一索引,不做逐条比较,
 *   所以不存在密码验证那种时序侧信道。
 * - `sess_` 前缀纯为可读性与日志告警的正则识别,它参与 hash 计算。
 */

import { createHash, randomBytes } from 'node:crypto';
import type { IssuedToken, TokenGenerator } from '../../domain/auth/token-generator.js';

const PREFIX = 'sess_';
const ENTROPY_BYTES = 32;

export class CryptoTokenGenerator implements TokenGenerator {
  issue(): IssuedToken {
    const raw = PREFIX + randomBytes(ENTROPY_BYTES).toString('base64url');
    return { raw, hash: this.hashOf(raw) };
  }

  hashOf(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
