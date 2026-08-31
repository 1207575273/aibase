/**
 * 登录密码解密端口。
 *
 * 干什么: 把前端加密后的密码还原成明文,并校验其中的一次性 nonce。
 *
 * 为什么抽成端口: 密钥怎么生成、放内存还是放文件、用不用 KMS,
 * 是部署环境的决定,不该写进业务逻辑。
 * AuthService 只关心"给我密文,还我明文",换实现不动业务代码。
 */

export interface LoginChallenge {
  keyId: string;
  /** RSA 公钥,SPKI 格式 base64。 */
  publicKey: string;
  nonce: string;
  expiresInSec: number;
}

export interface LoginCrypto {
  /** 签发一次挑战(公钥 + 一次性 nonce)。 */
  issueChallenge(): LoginChallenge;

  /**
   * 解密并校验。
   *
   * 实现必须做到:
   * 1. 解不开(密钥不对 / 密文损坏)-> 抛 AppError,**不要**把底层 crypto 错误透出去
   *    (那会泄漏密钥状态等内部信息)
   * 2. nonce 不存在 / 已过期 / 已被用过 -> 抛 AppError
   * 3. 校验通过后**立即作废该 nonce**(单次有效,防重放)
   *
   * @returns 明文密码
   */
  decryptPassword(cipher: string): Promise<string>;
}
