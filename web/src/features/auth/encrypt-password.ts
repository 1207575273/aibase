/**
 * 登录密码加密 —— RSA-OAEP + AES-GCM 混合,走浏览器原生 Web Crypto,零依赖。
 *
 * ── 这东西解决什么问题 ────────────────────────────────────────
 *
 * **它不能替代 HTTPS**。传输安全始终由 TLS 负责,这一点必须清楚,
 * 否则会产生"已经加密了所以 http 也行"的错觉,那比不加密更危险。
 *
 * 它真正解决的是密码在**中间环节被顺手记下来**:
 *   - 浏览器 DevTools 的 Network 面板(旁边有人、或者截图发群里)
 *   - nginx / WAF 开了请求体日志
 *   - APM、错误上报工具抓取请求体
 *   - HTTPS 在网关终止后,网关到后端那一段是明文
 * 以及安全测评对「口令加密传输」的硬性要求(等保、各类扫描器)。
 *
 * ── 为什么不是"前端 SHA256 一下" ──────────────────────────────
 *
 * 那是最常见的错误做法:哈希值会直接变成新的口令 ——
 * 攻击者拿到哈希就能登录,完全不需要还原原密码。等于什么都没做。
 *
 * ── 为什么需要 nonce ─────────────────────────────────────────
 *
 * 没有它的话,同一段密文可以被无限重放,密文本身就成了长期有效的凭据。
 * 服务端发一次性 nonce,加密时带上,用过即废。
 *
 * ── 为什么是混合加密 ─────────────────────────────────────────
 *
 * RSA-2048/OAEP 一次最多加密 190 字节。密码上限 128 字符,
 * 若是中文(UTF-8 每字 3 字节)就有 384 字节,直接超限 ——
 * 那会是个"只有设了长中文密码的用户才会遇到"的线上故障。
 * 混合加密没有长度限制,也是 TLS 自己在用的思路。
 */

import type { LoginChallengeResponse } from '@app/contracts';

const b64url = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64url = (value: string): Uint8Array => {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
};

/**
 * 用挑战里的公钥加密密码。
 *
 * @returns 密文,格式 `<keyId>.<RSA(AES密钥)>.<iv>.<AES-GCM(载荷)>`
 */
export const encryptPassword = async (
  password: string,
  challenge: LoginChallengeResponse,
): Promise<string> => {
  const { subtle } = globalThis.crypto;

  // 1. 导入服务端公钥
  const publicKey = await subtle.importKey(
    'spki',
    fromB64url(challenge.publicKey) as unknown as ArrayBuffer,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );

  // 2. 随机生成一把一次性 AES 密钥
  const aesKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);

  // 3. 用 AES-GCM 加密真正的载荷。nonce 必须一起加密进去 ——
  //    放在密文外面的话攻击者可以随意替换,防重放就失效了
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(
    JSON.stringify({ p: password, n: challenge.nonce }),
  );
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, payload);

  // 4. 用 RSA 公钥加密那把 AES 密钥
  const rawAesKey = await subtle.exportKey('raw', aesKey);
  const wrappedKey = await subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawAesKey);

  return [
    challenge.keyId,
    b64url(wrappedKey),
    b64url(iv.buffer as ArrayBuffer),
    b64url(data),
  ].join('.');
};

/**
 * Web Crypto 是否可用。
 *
 * 浏览器只在**安全上下文**(https 或 localhost)下暴露 crypto.subtle ——
 * 用局域网 IP 走 http 访问时它是 undefined。
 * 调用方据此退回明文通道,而不是抛一个让人摸不着头脑的错误。
 */
export const canEncrypt = (): boolean =>
  typeof globalThis.crypto?.subtle?.importKey === 'function';
