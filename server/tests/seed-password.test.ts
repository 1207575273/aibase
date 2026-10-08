import { describe, expect, it } from 'vitest';
import { requireAdminPassword } from '../prisma/seed-password.js';

describe('requireAdminPassword', () => {
  it('should_return_env_value_when_set', () => {
    expect(requireAdminPassword('admin12345')).toBe('admin12345');
  });

  it('should_throw_when_env_missing', () => {
    expect(() => requireAdminPassword(undefined)).toThrow('SEED_ADMIN_PASSWORD');
  });

  it('should_throw_when_env_empty', () => {
    // compose 的 ${SEED_ADMIN_PASSWORD:-} 未配置时传空串,不能拿空串当密码
    expect(() => requireAdminPassword('')).toThrow('SEED_ADMIN_PASSWORD');
  });
});
