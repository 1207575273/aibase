/**
 * JWT(HS256)的签发与验证 —— 用 node:crypto 手写,不引第三方库。
 *
 * 为什么不引 jose/jsonwebtoken: 本项目安全相关的部分一律零第三方依赖
 * (密码哈希用 node:crypto 的 scrypt,登录加密用 Web Crypto)。HS256 的全部内容
 * 就是「base64url(header).base64url(payload) 拿 HMAC-SHA256 签一下」,
 * 手写反而比引一个几百 KB、自带算法协商与 JWK 解析的库更容易审计。
 *
 * ── 手写 JWT 的两个必须做对的地方 ──────────────────────────────
 *
 * 1. **必须校验 alg 头**。历史上最经典的 JWT 漏洞是 `alg: none`:
 *    攻击者把 header 改成 {"alg":"none"} 并去掉签名,验证方若信任 header 里的
 *    算法声明,就会认为「这个 token 声明不需要签名」而直接放行。
 *    这里写死只认 HS256,header 里是别的一律拒。
 *
 * 2. **签名比较必须恒定时间**。用 `===` 比较字符串会在第一个不同的字节返回,
 *    攻击者能通过测量响应时间逐字节爆破出正确签名。用 timingSafeEqual。
 *
 * 另外刻意不支持 `kid`、不支持 RS256/ES256、不做算法协商 ——
 * 单体应用里没有多方验签的需求,少一个可配置项就少一处能被绕过的地方。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  TokenClaims,
  TokenSigner,
  VerifyResult,
} from '../../domain/auth/token-signer.js';

/** 写死的算法。不做协商 —— 见文件头注释第 1 条。 */
const ALG = 'HS256';

const b64url = (buf: Buffer): string => buf.toString('base64url');
const b64urlJson = (value: unknown): string => b64url(Buffer.from(JSON.stringify(value), 'utf8'));

/** JWT 的 exp/iat 用秒,不是毫秒 —— 这是规范要求,写错会导致过期判断差 1000 倍。 */
const toSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);

interface JwtHeader {
  alg: string;
  typ: string;
}

interface JwtPayload extends TokenClaims {
  /** 签发时刻(秒)。 */
  iat: number;
  /** 过期时刻(秒)。 */
  exp: number;
}

export interface Hs256TokenSignerOptions {
  /** 签名密钥。长度不足会被构造函数拒绝。 */
  secret: string;
  /** 令牌有效期(秒)。 */
  ttlSeconds: number;
  /** 取当前时间。注入而不是直接 new Date() —— 测试要能把时间固定住。 */
  now: () => Date;
}

/**
 * 密钥最小长度。
 *
 * HS256 的安全性完全取决于密钥熵。32 字节是 HMAC-SHA256 的输出长度,
 * 短于它的密钥不会让算法更快,只会让暴力破解更容易。
 */
const MIN_SECRET_BYTES = 32;

export class Hs256TokenSigner implements TokenSigner {
  private readonly key: Buffer;
  private readonly ttlSeconds: number;
  private readonly now: () => Date;

  constructor(opts: Hs256TokenSignerOptions) {
    const key = Buffer.from(opts.secret, 'utf8');
    if (key.byteLength < MIN_SECRET_BYTES) {
      // 启动期直接崩,而不是签出一堆弱令牌之后才被发现
      throw new Error(
        `JWT_SECRET 至少需要 ${MIN_SECRET_BYTES} 字节,当前 ${key.byteLength} 字节。` +
          `生成一个: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
      );
    }
    this.key = key;
    this.ttlSeconds = opts.ttlSeconds;
    this.now = opts.now;
  }

  private signingInput(header: string, payload: string): string {
    return `${header}.${payload}`;
  }

  private hmac(input: string): Buffer {
    return createHmac('sha256', this.key).update(input, 'utf8').digest();
  }

  sign(claims: TokenClaims): { token: string; expiresAt: Date } {
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.ttlSeconds * 1000);

    const header: JwtHeader = { alg: ALG, typ: 'JWT' };
    const payload: JwtPayload = {
      ...claims,
      iat: toSeconds(issuedAt),
      exp: toSeconds(expiresAt),
    };

    const h = b64urlJson(header);
    const p = b64urlJson(payload);
    const sig = b64url(this.hmac(this.signingInput(h, p)));

    return { token: `${h}.${p}.${sig}`, expiresAt };
  }

  verify(token: string): VerifyResult {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'invalid' };

    const [h, p, sig] = parts as [string, string, string];

    // 先验签再解载荷 —— 载荷在验签通过前是完全不可信的输入,
    // 顺序反过来等于拿攻击者控制的 JSON 去喂后续逻辑。
    const expected = this.hmac(this.signingInput(h, p));
    let actual: Buffer;
    try {
      actual = Buffer.from(sig, 'base64url');
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    // timingSafeEqual 要求两侧长度相等,长度不等时它会抛而不是返回 false
    if (actual.byteLength !== expected.byteLength) return { ok: false, reason: 'invalid' };
    if (!timingSafeEqual(actual, expected)) return { ok: false, reason: 'invalid' };

    let header: JwtHeader;
    let payload: JwtPayload;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as JwtHeader;
      payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as JwtPayload;
    } catch {
      return { ok: false, reason: 'invalid' };
    }

    // 即使签名对了也要卡 alg:签名是我们自己的密钥算的,但 header 里的算法声明
    // 属于载荷的一部分,放任它变化等于给未来的算法降级留口子。
    if (header.alg !== ALG) return { ok: false, reason: 'invalid' };

    if (typeof payload.exp !== 'number' || typeof payload.sub !== 'string') {
      return { ok: false, reason: 'invalid' };
    }

    const expiresAt = new Date(payload.exp * 1000);
    if (expiresAt.getTime() <= this.now().getTime()) return { ok: false, reason: 'expired' };

    return {
      ok: true,
      expiresAt,
      claims: {
        sub: payload.sub,
        username: payload.username,
        roleCodes: payload.roleCodes ?? [],
        superAdmin: payload.superAdmin === true,
        dataScope: payload.dataScope,
        permissions: payload.permissions ?? [],
      },
    };
  }
}
