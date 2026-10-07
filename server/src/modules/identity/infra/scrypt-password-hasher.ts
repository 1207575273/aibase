/**
 * 密码哈希实现 —— node:crypto 的 scrypt,零第三方依赖。
 *
 * ── 为什么是 scrypt 而不是装 argon2 ─────────────────────────────
 *
 * 候选包与否决理由(都踩了硬约束):
 * - bcrypt 5.x        CJS-only + node-gyp 编译,Windows/Alpine 都要装工具链
 * - argon2 (node-argon2)  同样 CJS + node-gyp
 * - bcryptjs 3.x      纯 JS 无原生,但 bcrypt 有 72 字节静默截断的经典坑,
 *                     且纯 JS 实现慢到没法把成本参数调高
 * - @node-rs/argon2   napi-rs 预编译无需 node-gyp,是"确实要 argon2id"时的升级项
 *
 * 选内置 scrypt 的理由:
 * 1. Node 22 自带,纯 ESM,零依赖、零原生编译、零供应链风险、零 Alpine 兼容问题。
 *    模板会被 clone 很多次,每一个原生模块都是一次"新人跑不起来"的概率。
 * 2. OWASP Password Storage 明确把 scrypt(N=2^16, r=8, p=2 正是其列出的合规参数组之一)
 *    列为 Argon2id 不可用时的推荐算法 —— 这不是将就。
 * 3. 哈希串自带算法名与成本参数,所以"以后换 argon2id"不是破坏性变更:
 *    verify 按前缀分派旧算法,hash 一律写新算法,用户下次登录自动升级,
 *    **不需要强制全员重置密码**。这条让默认选 scrypt 的决策成本降到接近零。
 *
 * [WARN] 单次哈希占约 64MiB 内存。10 个并发登录就是 640MiB,足以打爆容器内存限制。
 *   所以登录限流中间件是**必需品不是加分项**。
 *   同时这是一条硬纪律: hash/verify 只允许出现在登录、改密、建号三条路径,
 *   禁止进循环、禁止批量导入用户时逐条同步哈希。
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { PasswordHasher } from '../domain/password-hasher.js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const ALGO = 'scrypt';
const N = 1 << 16; // 65536
const R = 8;
const P = 2;
const KEY_LEN = 32;
const SALT_LEN = 16;

/**
 * [坑] Node 的 scrypt 默认 maxmem 是 32MiB,而 N=2^16,r=8 需要 128*N*r = 64MiB,
 * 不显式传就会在**第一次哈希时**抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMS。
 * 这类参数错误本地和 CI 都可能测不出来(如果 seed 用了低成本参数),
 * 只会在生产第一次建号时炸 —— 所以下面有一个真跑 hash+verify 的单测当护栏。
 */
const MAX_MEM = 128 * N * R * 2;

/** PHC 风格: $scrypt$N=65536,r=8,p=2$<salt-base64url>$<dk-base64url> */
const encode = (salt: Buffer, dk: Buffer): string =>
  `$${ALGO}$N=${N},r=${R},p=${P}$${salt.toString('base64url')}$${dk.toString('base64url')}`;

interface ParsedHash {
  algo: string;
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  dk: Buffer;
}

const parse = (stored: string): ParsedHash | null => {
  // 形如 ['', 'scrypt', 'N=65536,r=8,p=2', '<salt>', '<dk>']
  const parts = stored.split('$');
  if (parts.length !== 5) return null;

  const [, algo, params, saltB64, dkB64] = parts;
  if (algo === undefined || params === undefined || saltB64 === undefined || dkB64 === undefined) {
    return null;
  }

  const nums: Record<string, number> = {};
  for (const kv of params.split(',')) {
    const [k, v] = kv.split('=');
    if (k === undefined || v === undefined) return null;
    const parsed = Number(v);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    nums[k] = parsed;
  }
  const { N: n, r, p } = nums;
  if (n === undefined || r === undefined || p === undefined) return null;

  try {
    return {
      algo,
      N: n,
      r,
      p,
      salt: Buffer.from(saltB64, 'base64url'),
      dk: Buffer.from(dkB64, 'base64url'),
    };
  } catch {
    return null;
  }
};

export class ScryptPasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    const salt = randomBytes(SALT_LEN);
    const dk = await scrypt(plain, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAX_MEM });
    return encode(salt, dk);
  }

  async verify(plain: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
    const parsed = parse(stored);
    // 存储串损坏/格式不认识:当作验证失败,而不是抛异常。
    // 抛异常会让"库里有一条脏数据"升级成 500,而正确行为是这个用户登不上去。
    if (parsed === null || parsed.algo !== ALGO) {
      return { ok: false, needsRehash: false };
    }

    // 用**存储串里的参数**重算,而不是当前常量 —— 这才能验证用旧成本参数生成的老哈希。
    const dk = await scrypt(plain, parsed.salt, parsed.dk.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: Math.max(MAX_MEM, 128 * parsed.N * parsed.r * 2),
    });

    // [安全] 必须用 timingSafeEqual 而不是 ===。
    // === 会在第一个不同字节处提前返回,攻击者可以通过测量响应时间逐字节爆破。
    // 长度不等时 timingSafeEqual 会抛,所以先比长度。
    const ok = dk.length === parsed.dk.length && timingSafeEqual(dk, parsed.dk);

    // 参数低于当前标准 -> 提示调用方在登录成功后用新参数重新哈希。
    const needsRehash = parsed.N < N || parsed.r < R || parsed.p < P;
    return { ok, needsRehash };
  }
}
