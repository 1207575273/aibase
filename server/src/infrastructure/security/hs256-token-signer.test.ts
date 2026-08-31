/**
 * HS256 令牌签发/验签的单测。
 *
 * 这是手写的密码学代码,而且是整个鉴权链路的根 —— 它错了不会报错,
 * 只会让伪造的令牌被当成合法身份放行。所以攻击面要逐条测,
 * 尤其是 `alg: none` 与签名篡改这两类经典绕过。
 */

import { describe, expect, it } from 'vitest';
import { Hs256TokenSigner } from './hs256-token-signer.js';
import type { TokenClaims } from '../../domain/auth/token-signer.js';

const SECRET = 'a'.repeat(48);
const NOW = new Date('2026-01-01T00:00:00.000Z');

const claims: TokenClaims = {
  sub: 'u1',
  username: 'alice',
  roleCodes: ['ADMIN'],
  superAdmin: false,
  dataScope: 'ALL',
  permissions: ['user:read'],
};

const makeSigner = (now: Date = NOW, ttlSeconds = 3600): Hs256TokenSigner =>
  new Hs256TokenSigner({ secret: SECRET, ttlSeconds, now: () => now });

/** 改写令牌的某一段(0=header, 1=payload),重新拼回去。签名段保持原样。 */
const tamperSegment = (token: string, index: 0 | 1, mutate: (obj: Record<string, unknown>) => void): string => {
  const parts = token.split('.');
  const obj = JSON.parse(Buffer.from(parts[index] as string, 'base64url').toString('utf8')) as Record<string, unknown>;
  mutate(obj);
  parts[index] = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return parts.join('.');
};

describe('构造', () => {
  it('should_reject_short_secret', () => {
    // 密钥太短会让暴力破解可行,必须启动期就崩,而不是签出一堆弱令牌
    expect(() => new Hs256TokenSigner({ secret: 'short', ttlSeconds: 60, now: () => NOW })).toThrow(/32 字节/);
  });
});

describe('签发与验证', () => {
  it('should_roundtrip_claims', () => {
    const signer = makeSigner();
    const { token } = signer.sign(claims);
    const result = signer.verify(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.sub).toBe('u1');
    expect(result.claims.username).toBe('alice');
    expect(result.claims.roleCodes).toEqual(['ADMIN']);
    expect(result.claims.permissions).toEqual(['user:read']);
  });

  it('should_set_expiry_from_ttl', () => {
    const { expiresAt } = makeSigner(NOW, 3600).sign(claims);
    expect(expiresAt.getTime()).toBe(NOW.getTime() + 3600_000);
  });

  it('should_report_expired_after_ttl', () => {
    const { token } = makeSigner(NOW, 60).sign(claims);
    // 用另一个"当前时间"在未来的签名器去验
    const later = new Date(NOW.getTime() + 61_000);
    const result = makeSigner(later, 60).verify(token);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 过期与伪造要能区分:前端据此决定"跳登录页"还是"报错"
    expect(result.reason).toBe('expired');
  });
});

describe('攻击面', () => {
  it('should_reject_alg_none', () => {
    // 最经典的 JWT 绕过:把算法声明改成 none 并去掉签名。
    // 验证方若信任 header 里的 alg,就会认为"这个令牌声明不需要签名"而放行。
    const { token } = makeSigner().sign(claims);
    const [, payload] = token.split('.');
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url');
    const forged = `${header}.${payload}.`;

    expect(makeSigner().verify(forged).ok).toBe(false);
  });

  it('should_reject_tampered_payload', () => {
    // 把自己提权成超管 —— 载荷变了签名就对不上
    const { token } = makeSigner().sign(claims);
    const forged = tamperSegment(token, 1, (p) => {
      p['superAdmin'] = true;
    });

    expect(makeSigner().verify(forged).ok).toBe(false);
  });

  it('should_reject_tampered_algorithm_header', () => {
    // 即使签名是我们自己算的,header 里的 alg 被改也要拒 —— 不给算法降级留口子
    const { token } = makeSigner().sign(claims);
    const forged = tamperSegment(token, 0, (h) => {
      h['alg'] = 'HS512';
    });

    expect(makeSigner().verify(forged).ok).toBe(false);
  });

  it('should_reject_token_signed_with_other_secret', () => {
    const other = new Hs256TokenSigner({ secret: 'b'.repeat(48), ttlSeconds: 3600, now: () => NOW });
    const { token } = other.sign(claims);

    expect(makeSigner().verify(token).ok).toBe(false);
  });

  it('should_reject_malformed_tokens', () => {
    const signer = makeSigner();
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', '...', 'not-a-jwt']) {
      expect(signer.verify(bad).ok, `应拒绝: ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('should_reject_signature_truncated_by_one_byte', () => {
    // 签名长度不等时 timingSafeEqual 会抛,必须提前判长度而不是让它冒泡
    const { token } = makeSigner().sign(claims);
    const parts = token.split('.');
    const sig = Buffer.from(parts[2] as string, 'base64url');
    parts[2] = sig.subarray(0, sig.length - 1).toString('base64url');

    expect(() => makeSigner().verify(parts.join('.'))).not.toThrow();
    expect(makeSigner().verify(parts.join('.')).ok).toBe(false);
  });
});
