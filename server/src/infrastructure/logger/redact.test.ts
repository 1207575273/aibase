/**
 * 日志脱敏护栏。
 *
 * 为什么值得单独测: 密码落进日志是"发生了也不会有人告诉你"的事故 ——
 * 等发现时日志已经写了几个月,而且备份里也有。
 *
 * 特别要钉住的是**任意深度**都要脱敏。pino 内置的 redact 是路径匹配,
 * 实测漏掉 `deep.deeper.password`(因为没人声明那条路径)——
 * 这正是本模板不用它、自己写递归实现的原因。
 */

import { describe, expect, it } from 'vitest';
import { REDACTED, sanitize } from './redact.js';

/** 判断整个结构里还有没有残留的明文。 */
const leaks = (value: unknown, secret: string): boolean =>
  JSON.stringify(value).includes(secret);

describe('sanitize', () => {
  const SECRET = 'super-secret-value';

  it('should_redact_top_level_sensitive_keys', () => {
    const out = sanitize({ password: SECRET, name: 'ok' }) as Record<string, unknown>;
    expect(out['password']).toBe(REDACTED);
    expect(out['name']).toBe('ok');
  });

  it.each([
    ['password'],
    ['passwordHash'],
    ['oldPassword'],
    ['newPassword'],
    ['token'],
    ['accessToken'],
    ['authorization'],
    ['Cookie'],
    ['API_KEY'],
    ['apiKey'],
    ['privateKey'],
    ['passphrase'],
    ['sessionId'],
  ])('should_redact_key_%s', (key) => {
    const out = sanitize({ [key]: SECRET });
    expect(leaks(out, SECRET), `键名 ${key} 没有被脱敏`).toBe(false);
  });

  it('should_redact_at_any_depth', () => {
    // ★ 这条是不用 pino 内置 redact 的直接理由。
    // 真实场景: logger.error('保存失败', { input }),而 input 里嵌着 user 对象。
    // 敏感字段出现在第几层是无法预先声明的。
    const deep = { a: { b: { c: { d: { password: SECRET } } } } };
    expect(leaks(sanitize(deep), SECRET)).toBe(false);
  });

  it('should_redact_inside_arrays', () => {
    const users = { users: [{ name: 'a', password: SECRET }, { name: 'b' }] };
    expect(leaks(sanitize(users), SECRET)).toBe(false);
  });

  it('should_keep_non_sensitive_data_intact', () => {
    // 脱敏不能把日志变得没信息量 —— 该留的必须留
    const out = sanitize({
      userId: 'u-1',
      traceId: 't-1',
      status: 200,
      durationMs: 42,
      nested: { path: '/api/persons' },
    }) as Record<string, unknown>;

    expect(out['userId']).toBe('u-1');
    expect(out['status']).toBe(200);
    expect((out['nested'] as Record<string, unknown>)['path']).toBe('/api/persons');
  });

  it('should_serialize_error_with_stack', () => {
    // 错误对象直接 JSON.stringify 会变成 {} —— 堆栈全丢,排查时最需要的东西没了
    const out = sanitize({ err: new Error('boom') }) as { err: Record<string, unknown> };
    expect(out.err['message']).toBe('boom');
    expect(String(out.err['stack'])).toContain('boom');
  });

  it('should_convert_date_and_bigint', () => {
    const out = sanitize({ at: new Date('2026-08-27T10:00:00Z'), n: 10n }) as Record<
      string,
      unknown
    >;
    expect(out['at']).toBe('2026-08-27T10:00:00.000Z');
    expect(out['n']).toBe('10');
  });

  it('should_truncate_long_arrays', () => {
    const out = sanitize({ items: Array.from({ length: 100 }, (_, i) => i) }) as {
      items: unknown[];
    };
    // 一行日志刷屏几千字符会把真正有用的信息淹没
    expect(out.items.length).toBeLessThanOrEqual(21);
    expect(String(out.items[20])).toContain('more');
  });

  it('should_survive_circular_reference', () => {
    // 循环引用不该让打日志这件事本身抛异常
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    expect(() => JSON.stringify(sanitize(a))).not.toThrow();
  });
});
