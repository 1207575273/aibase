/**
 * 迁移门禁:迁移 SQL 不得写死 schema。
 *
 * 同一套迁移要在每个项目自己的 schema 里跑(靠 search_path 决定落点)。
 * 一旦出现 "public"."xxx" 这种限定名,迁移会越过 search_path 直接改 public ——
 * 在共享 PG 上就是改到了别人的地盘。prisma migrate diff 在某些版本会生成带 "public". 的 DDL,
 * 手写进迁移前要去掉。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma/migrations');

const migrationFiles = readdirSync(MIGRATIONS)
  .filter((name) => statSync(resolve(MIGRATIONS, name)).isDirectory())
  .map((name) => resolve(MIGRATIONS, name, 'migration.sql'));

describe('迁移 SQL', () => {
  it('should_find_at_least_one_migration_when_scanning', () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it.each(migrationFiles)('should_not_qualify_public_schema_when_writing_%s', (file) => {
    const offending = readFileSync(file, 'utf8')
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => !text.trimStart().startsWith('--') && /"public"\s*\./i.test(text));
    expect(offending, '迁移里出现了写死的 "public". 限定名,删掉 schema 前缀').toEqual([]);
  });
});
