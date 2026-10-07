/**
 * scrypt 参数护栏 —— 真跑一次 hash + verify。
 *
 * 为什么必须真跑: maxmem 参数配错时,错误只在**第一次实际哈希**时抛出
 * (ERR_CRYPTO_INVALID_SCRYPT_PARAMS)。任何 mock 掉 crypto 的测试都发现不了,
 * 只会在生产第一次建号时炸。这几个用例是这条风险的唯一防线。
 *
 * [注意] 每个用例真跑 scrypt,单次约 100~200ms,这里有意接受这个成本。
 */

import { describe, expect, it } from 'vitest';
import { ScryptPasswordHasher } from './scrypt-password-hasher.js';

const hasher = new ScryptPasswordHasher();

describe('ScryptPasswordHasher', () => {
  it('should_verify_ok_when_password_matches', async () => {
    const stored = await hasher.hash('correct horse battery staple');
    const result = await hasher.verify('correct horse battery staple', stored);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(false);
  });

  it('should_verify_fail_when_password_differs', async () => {
    const stored = await hasher.hash('right-password');
    expect((await hasher.verify('wrong-password', stored)).ok).toBe(false);
  });

  it('should_produce_phc_style_string_with_params', async () => {
    const stored = await hasher.hash('x');
    // 格式契约:换算法时 verify 要靠这个前缀分派,不能随便改
    expect(stored).toMatch(/^\$scrypt\$N=65536,r=8,p=2\$[\w-]+\$[\w-]+$/);
  });

  it('should_produce_different_hash_for_same_password', async () => {
    // salt 随机 -> 同一密码两次哈希结果必须不同。
    // 相同就意味着 salt 没生效,彩虹表直接可用。
    const a = await hasher.hash('same');
    const b = await hasher.hash('same');
    expect(a).not.toBe(b);
  });

  it('should_handle_unicode_and_long_passwords', async () => {
    // bcrypt 有 72 字节静默截断的坑,scrypt 没有 —— 这里验证一下
    const long = '密码'.repeat(40); // 远超 72 字节
    const stored = await hasher.hash(long);
    expect((await hasher.verify(long, stored)).ok).toBe(true);
    expect((await hasher.verify(long.slice(0, -1), stored)).ok).toBe(false);
  });

  it('should_return_false_when_stored_hash_is_malformed', async () => {
    // 库里出现脏数据时应该是"这个用户登不上",而不是 500
    for (const bad of ['', 'garbage', '$scrypt$bad', '$argon2$N=1,r=1,p=1$a$b']) {
      const result = await hasher.verify('x', bad);
      expect(result.ok).toBe(false);
    }
  });

  it('should_flag_needs_rehash_when_cost_params_are_lower', async () => {
    // 手工构造一个低成本参数的哈希串,模拟"以前用弱参数存的老密码"。
    // 验证仍能通过(不强制用户重置),但会被标记为需要升级。
    const { scrypt: scryptCb, randomBytes } = await import('node:crypto');
    const { promisify } = await import('node:util');
    const scrypt = promisify(scryptCb) as (
      p: string,
      s: Buffer,
      k: number,
      o: { N: number; r: number; p: number; maxmem: number },
    ) => Promise<Buffer>;

    const salt = randomBytes(16);
    const weakN = 1 << 14;
    const dk = await scrypt('legacy', salt, 32, {
      N: weakN,
      r: 8,
      p: 1,
      maxmem: 128 * weakN * 8 * 2,
    });
    const legacy = `$scrypt$N=${weakN},r=8,p=1$${salt.toString('base64url')}$${dk.toString('base64url')}`;

    const result = await hasher.verify('legacy', legacy);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(true);
  });
});
