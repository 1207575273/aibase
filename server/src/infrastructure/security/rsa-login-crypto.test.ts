/**
 * 登录密码加密的回归护栏。
 *
 * 这里的用例分两类:
 *   1. **往返正确性** —— 用与浏览器完全相同的 Web Crypto API 加密,后端能解开
 *   2. **攻击面** —— 重放、篡改、过期、换密钥,每一条都必须被拒
 *
 * 第二类才是重点。加密功能"能用"是容易的,难的是它真的挡住了该挡的东西 ——
 * 一个只测往返的实现可能连重放都防不住,那样密文就成了新的长期口令。
 */

import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { RsaLoginCrypto } from './rsa-login-crypto.js';
import type { LoginChallenge } from '../../domain/auth/login-crypto.js';

const subtle = webcrypto.subtle;

const b64url = (buf: ArrayBuffer): string => Buffer.from(buf).toString('base64url');
const fromB64url = (v: string): Buffer => Buffer.from(v, 'base64url');

/**
 * 篡改一段 base64url 数据 —— 解码后翻转某个字节的比特再编码回去。
 *
 * [坑] 不能简单地改最后一个字符: base64 末位字符可能只承载「会被丢弃的补位比特」,
 * 改了它解码出来的字节序列**完全相同**,测试就会误以为"篡改没被检测到"。
 * (第一版就是这么写的,结果测试红了,但错的是测试不是实现。)
 * 在字节层面翻转才能保证内容真的变了。
 */
const tamper = (segment: string, byteIndex = 1): string => {
  const bytes = fromB64url(segment);
  const i = Math.min(byteIndex, bytes.length - 1);
  bytes[i] = (bytes[i] ?? 0) ^ 0xff;
  return bytes.toString('base64url');
};

/**
 * 模拟浏览器侧的加密。
 * 刻意用与 web/src/features/auth/encrypt-password.ts 一样的 Web Crypto 调用 ——
 * 两边用的是同一套标准 API,所以这里验通了浏览器侧也就通了。
 */
const clientEncrypt = async (
  password: string,
  challenge: LoginChallenge,
  overrideNonce?: string,
): Promise<string> => {
  const publicKey = await subtle.importKey(
    'spki',
    fromB64url(challenge.publicKey),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const aesKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(
    JSON.stringify({ p: password, n: overrideNonce ?? challenge.nonce }),
  );
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, payload);
  const wrapped = await subtle.encrypt(
    { name: 'RSA-OAEP' },
    publicKey,
    await subtle.exportKey('raw', aesKey),
  );
  return [challenge.keyId, b64url(wrapped), b64url(iv.buffer), b64url(data)].join('.');
};

describe('RsaLoginCrypto', () => {
  let now: Date;
  let crypto: RsaLoginCrypto;

  beforeEach(async () => {
    now = new Date('2026-08-27T10:00:00.000Z');
    crypto = new RsaLoginCrypto({ clock: () => now });
    await crypto.init();
  });

  describe('往返', () => {
    it('should_decrypt_password_encrypted_by_client', async () => {
      const challenge = crypto.issueChallenge();
      const cipher = await clientEncrypt('my-secret-password', challenge);
      expect(await crypto.decryptPassword(cipher)).toBe('my-secret-password');
    });

    it('should_handle_long_unicode_password', async () => {
      // 混合加密存在的理由: RSA-2048 直接加密上限 190 字节,
      // 128 个中文字符是 384 字节,纯 RSA 方案在这里就炸了
      const password = '这是一个很长的中文密码'.repeat(10);
      expect(new TextEncoder().encode(password).length).toBeGreaterThan(190);

      const challenge = crypto.issueChallenge();
      expect(await crypto.decryptPassword(await clientEncrypt(password, challenge))).toBe(password);
    });

    it('should_issue_different_nonce_each_time', async () => {
      const a = crypto.issueChallenge();
      const b = crypto.issueChallenge();
      expect(a.nonce).not.toBe(b.nonce);
      // 同一个进程内密钥不变,所以 keyId 相同
      expect(a.keyId).toBe(b.keyId);
    });
  });

  describe('攻击面', () => {
    it('should_reject_replay_of_same_cipher', async () => {
      // ★ 最关键的一条。没有它的话密文就是一个长期有效的凭据 ——
      // 攻击者抓到一次就能反复登录,前端加密等于白做。
      const challenge = crypto.issueChallenge();
      const cipher = await clientEncrypt('pw', challenge);

      expect(await crypto.decryptPassword(cipher)).toBe('pw');
      await expect(crypto.decryptPassword(cipher)).rejects.toMatchObject({
        code: 'AUTH_LOGIN_KEY_EXPIRED',
      });
    });

    it('should_reject_unknown_nonce', async () => {
      const challenge = crypto.issueChallenge();
      // 客户端自己编一个 nonce —— 服务端没发过,必须拒
      const cipher = await clientEncrypt('pw', challenge, 'forged-nonce');
      await expect(crypto.decryptPassword(cipher)).rejects.toMatchObject({
        code: 'AUTH_LOGIN_KEY_EXPIRED',
      });
    });

    it('should_reject_expired_nonce', async () => {
      const challenge = crypto.issueChallenge();
      const cipher = await clientEncrypt('pw', challenge);
      // 时钟往后拨 6 分钟(TTL 是 5 分钟)
      now = new Date(now.getTime() + 6 * 60 * 1000);
      await expect(crypto.decryptPassword(cipher)).rejects.toMatchObject({
        code: 'AUTH_LOGIN_KEY_EXPIRED',
      });
    });

    it('should_reject_cipher_from_another_key', async () => {
      // 模拟"服务重启换了密钥"或"攻击者拿别的公钥加密"
      const other = new RsaLoginCrypto({ clock: () => now });
      await other.init();
      const cipher = await clientEncrypt('pw', other.issueChallenge());

      await expect(crypto.decryptPassword(cipher)).rejects.toMatchObject({
        code: 'AUTH_LOGIN_KEY_EXPIRED',
      });
    });

    it('should_reject_tampered_ciphertext', async () => {
      const challenge = crypto.issueChallenge();
      const cipher = await clientEncrypt('pw', challenge);
      const parts = cipher.split('.');
      // AES-GCM 带认证标签,密文里任何一个比特被改都会在解密时被检测出来
      const tampered = [parts[0], parts[1], parts[2], tamper(parts[3] ?? '')].join('.');

      await expect(crypto.decryptPassword(tampered)).rejects.toMatchObject({
        // [安全] 篡改与密码错误返回**同一个码** —— 区分开等于给攻击者
        // 一个逐步试探密钥状态的信道
        code: 'AUTH_INVALID_CREDENTIALS',
      });
    });

    it.each([
      ['空串', ''],
      ['段数不对', 'a.b.c'],
      ['垃圾数据', 'not-a-cipher'],
      ['段数过多', 'a.b.c.d.e'],
    ])('should_reject_malformed_cipher_%s', async (_label, cipher) => {
      await expect(crypto.decryptPassword(cipher)).rejects.toMatchObject({ httpStatus: 400 });
    });

    it('should_not_leak_which_part_failed', async () => {
      // 所有"解不开"的情况必须给出完全一样的错误,不能让攻击者据此区分
      // 是密钥不对、GCM 校验失败、还是 JSON 坏了
      const challenge = crypto.issueChallenge();
      const good = await clientEncrypt('pw', challenge);
      const parts = good.split('.');

      const badKey = [parts[0], tamper(parts[1] ?? ''), parts[2], parts[3]].join('.');
      const badData = [parts[0], parts[1], parts[2], tamper(parts[3] ?? '')].join('.');

      const codes: string[] = [];
      for (const cipher of [badKey, badData]) {
        try {
          await crypto.decryptPassword(cipher);
        } catch (e) {
          codes.push((e as { code: string }).code);
        }
      }
      expect(new Set(codes).size).toBe(1);
    });
  });
});
