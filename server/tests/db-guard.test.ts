/**
 * pnpm db 的判断逻辑:哪些 schema 允许改写结构、迁移名与目录名怎么生成。
 *
 * migrate / reset 只许在 _dev 结尾的 schema 上执行。_test / _prod 很可能与开发 schema 在同一个 PG 实例上,
 * reset 会清空整个 schema —— 在那里就是删真实数据。
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error 纯 JS 模块,无类型声明;pnpm db <子命令> 的入口
import { isDisposableSchema, migrationDirName, toMigrationName } from '../../scripts/db.mjs';

describe('isDisposableSchema', () => {
  it.each(['keel_dev', 'order_2_dev'])('should_allow_%s_when_schema_is_dev', (schema) => {
    expect(isDisposableSchema(schema)).toBe(true);
  });

  it.each(['keel_test', 'keel_prod', 'dev_keel', 'keel_devx', '_dev', 'public', '', undefined])(
    'should_refuse_%s_when_schema_is_not_dev',
    (schema) => {
      expect(isDisposableSchema(schema)).toBe(false);
    },
  );
});

describe('toMigrationName', () => {
  it.each([
    ['add_order', 'add_order'],
    ['Add Order', 'add_order'],
    ['  add-order-item  ', 'add_order_item'],
  ])('should_normalize_%p_to_%p', (raw, expected) => {
    expect(toMigrationName(raw)).toBe(expected);
  });

  it.each(['', '---', undefined])('should_return_null_when_name_is_%p', (raw) => {
    expect(toMigrationName(raw)).toBeNull();
  });
});

describe('migrationDirName', () => {
  it('should_prefix_utc_timestamp_when_building_dir_name', () => {
    expect(migrationDirName('add_order', new Date('2026-10-07T09:05:03.000Z'))).toBe('20261007090503_add_order');
  });
});
