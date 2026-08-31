/**
 * 登录密码解密实现 —— RSA-OAEP + AES-GCM 混合加密,零第三方依赖。
 *
 * ── 为什么是混合加密而不是纯 RSA ──────────────────────────────
 *
 * RSA-2048 配 OAEP-SHA256 一次最多只能加密 **190 字节**。
 * 密码上限 128 字符,如果全是中文(UTF-8 每字 3 字节)就是 384 字节,直接超限。
 * 那会变成一个只在"用户设了长中文密码"时才触发的线上故障。
 *
 * 混合加密没有长度限制:
 *   1. 随机生成一把 AES-256 密钥
 *   2. 用 AES-GCM 加密真正的载荷(密码 + nonce)
 *   3. 用 RSA 公钥加密那把 AES 密钥
 * 这是 TLS 本身也在用的思路。
 *
 * ── 密文格式 ─────────────────────────────────────────────────
 *   <keyId>.<base64url(RSA 加密的 AES 密钥)>.<base64url(iv)>.<base64url(密文)>
 * 四段用点分隔,自带 keyId 便于服务端判断密钥是否已轮换。
 *
 * ── 密钥生命周期 ─────────────────────────────────────────────
 * 进程启动时在内存里生成,**不落盘**。好处是没有密钥文件可泄漏、
 * 天然随重启轮换;代价是重启瞬间在途的登录会失败(用户重试即可),
 * 以及多实例部署时各实例密钥不同 —— 所以挑战与登录必须打到同一个实例
 * (本模板是单实例,不存在这个问题;真要多实例,把密钥挪到共享存储)。
 */

import { webcrypto } from 'node:crypto';
import { AUTH_ERROR } from '../../domain/auth/auth.errors.js';
import type { LoginChallenge, LoginCrypto } from '../../domain/auth/login-crypto.js';
import { invalid } from '../../domain/shared/app-error.js';
import type { Clock } from '../../domain/shared/clock.js';

const subtle = webcrypto.subtle;

/** Node 的 CryptoKey 在 webcrypto 命名空间下,不是全局类型。 */
type CryptoKey = webcrypto.CryptoKey;

const RSA_PARAMS = {
  name: 'RSA-OAEP',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
} as const;

/** nonce 有效期。够用户填完表单提交,又短到没有重放窗口。 */
const NONCE_TTL_MS = 5 * 60 * 1000;

/** nonce 数量上限。防止有人狂刷挑战接口把内存撑爆。 */
const MAX_NONCES = 10_000;

const b64url = (buf: ArrayBuffer): string => Buffer.from(buf).toString('base64url');

export interface RsaLoginCryptoDeps {
  clock: Clock;
}

export class RsaLoginCrypto implements LoginCrypto {
  private keyId = '';
  private publicKeySpki = '';
  private privateKey?: CryptoKey;

  /** nonce -> 过期时间戳。用过即删,所以存在即"尚未使用"。 */
  private readonly nonces = new Map<string, number>();

  constructor(private readonly deps: RsaLoginCryptoDeps) {}

  /** 启动时调用一次。放在构造函数外是因为密钥生成是异步的。 */
  async init(): Promise<void> {
    const pair = await subtle.generateKey(RSA_PARAMS, true, ['encrypt', 'decrypt']);
    this.privateKey = pair.privateKey;
    this.publicKeySpki = b64url(await subtle.exportKey('spki', pair.publicKey));
    // keyId 取公钥指纹前 16 位:同一把密钥永远得到同一个 id,重启后必然不同
    const digest = await subtle.digest('SHA-256', Buffer.from(this.publicKeySpki));
    this.keyId = Buffer.from(digest).toString('hex').slice(0, 16);
  }

  issueChallenge(): LoginChallenge {
    if (this.privateKey === undefined) {
      throw new Error('RsaLoginCrypto 未初始化,composition 层必须先 await init()');
    }
    const now = this.deps.clock().getTime();
    this.sweep(now);

    if (this.nonces.size >= MAX_NONCES) {
      // 满了说明有人在刷。拒绝新发放而不是无限增长 ——
      // 已发放的 nonce 五分钟内会自然过期
      throw invalid(AUTH_ERROR.TOO_MANY_ATTEMPTS, '登录请求过于频繁,请稍后再试');
    }

    const nonce = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    this.nonces.set(nonce, now + NONCE_TTL_MS);

    return {
      keyId: this.keyId,
      publicKey: this.publicKeySpki,
      nonce,
      expiresInSec: Math.floor(NONCE_TTL_MS / 1000),
    };
  }

  async decryptPassword(cipher: string): Promise<string> {
    if (this.privateKey === undefined) {
      throw new Error('RsaLoginCrypto 未初始化');
    }

    const parts = cipher.split('.');
    if (parts.length !== 4) throw this.rejected();
    const [keyId, wrappedKeyB64, ivB64, dataB64] = parts as [string, string, string, string];

    // 密钥已轮换(服务重启过)。单独给一个可辨识的提示 ——
    // 前端据此重新取挑战并自动重试,而不是让用户莫名其妙地"密码错误"
    if (keyId !== this.keyId) {
      throw invalid(AUTH_ERROR.LOGIN_KEY_EXPIRED, '登录凭据已失效,请重试');
    }

    let payload: { p?: unknown; n?: unknown };
    try {
      const rawAesKey = await subtle.decrypt(
        { name: 'RSA-OAEP' },
        this.privateKey,
        Buffer.from(wrappedKeyB64, 'base64url'),
      );
      const aesKey = await subtle.importKey('raw', rawAesKey, { name: 'AES-GCM' }, false, [
        'decrypt',
      ]);
      const plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: Buffer.from(ivB64, 'base64url') },
        aesKey,
        Buffer.from(dataB64, 'base64url'),
      );
      payload = JSON.parse(Buffer.from(plain).toString('utf8')) as { p?: unknown; n?: unknown };
    } catch {
      // [安全] 统一抛同一个错误,不区分"RSA 解不开"/"GCM 校验失败"/"JSON 坏了"——
      // 区分开等于给攻击者一个逐步试探密钥状态的信道
      throw this.rejected();
    }

    const { p: password, n: nonce } = payload;
    if (typeof password !== 'string' || typeof nonce !== 'string') throw this.rejected();

    this.consumeNonce(nonce);
    return password;
  }

  /** 校验并作废 nonce。单次有效是防重放的关键。 */
  private consumeNonce(nonce: string): void {
    const expiresAt = this.nonces.get(nonce);
    const now = this.deps.clock().getTime();

    if (expiresAt === undefined || expiresAt < now) {
      // 不存在 = 从没发过、或者已经被用掉了(重放)
      throw invalid(AUTH_ERROR.LOGIN_KEY_EXPIRED, '登录凭据已失效,请重试');
    }
    this.nonces.delete(nonce);
  }

  private sweep(now: number): void {
    for (const [nonce, expiresAt] of this.nonces) {
      if (expiresAt < now) this.nonces.delete(nonce);
    }
  }

  /** 对外一律是"用户名或密码错误",不暴露密文层面的任何细节。 */
  private rejected(): Error {
    return invalid(AUTH_ERROR.INVALID_CREDENTIALS, '用户名或密码错误');
  }
}
