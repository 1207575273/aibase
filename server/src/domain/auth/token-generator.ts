/**
 * 会话 token 生成端口。
 */
export interface IssuedToken {
  /** 明文 token。只在签发这一刻存在,发给客户端后服务端不再持有。 */
  raw: string;
  /** sha256(raw) 的 hex,存库用。 */
  hash: string;
}

export interface TokenGenerator {
  /** 签发一个新的高熵随机 token。 */
  issue(): IssuedToken;
  /** 计算明文 token 的 hash,用于按 token 查会话。 */
  hashOf(raw: string): string;
}
