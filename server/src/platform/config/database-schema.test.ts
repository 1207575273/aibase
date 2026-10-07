/**
 * DATABASE_SCHEMA 的取值校验。
 *
 * schema 名会进 search_path 与建表 SQL,只能靠白名单格式挡住注入,不能靠转义。
 */

import { describe, expect, it } from 'vitest';
import { DatabaseSchemaName } from './index.js';

describe('DatabaseSchemaName', () => {
  it('should_reject_when_not_set', () => {
    expect(DatabaseSchemaName.safeParse(undefined).success).toBe(false);
  });

  it.each(['dev_order', 'test_order', 'prod_order_2', 'public', '_tmp'])('should_accept_%p_when_valid_identifier', (name) => {
    expect(DatabaseSchemaName.parse(name)).toBe(name);
  });

  it.each(['', 'Order', 'p-order', '2abc', 'a;drop schema public', 'a b', 'x'.repeat(64)])(
    'should_reject_%p_when_not_lowercase_identifier',
    (name) => {
      expect(DatabaseSchemaName.safeParse(name).success).toBe(false);
    },
  );
});
