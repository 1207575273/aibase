/**
 * schema 隔离 —— 共享 PG 上"一个项目一个 schema"的前提是否成立。
 *
 * 沙箱里所有项目连同一个 PG 实例,靠 DATABASE_SCHEMA 分开。这里守三件事:
 *   1. 表建在指定 schema 里,而不是 public;
 *   2. 裸 SQL($queryRaw)也落在指定 schema —— adapter 的 schema 选项只管 Prisma 生成的查询,
 *      裸 SQL 靠连接级 search_path,少设一个就会悄悄读写到 public;
 *   3. 两个 schema 之间互相看不见对方的数据。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, type TestDb } from '../../../tests/helpers/test-db.js';

const now = new Date('2026-01-01T00:00:00.000Z');

const insertRole = async (db: TestDb, id: string, code: string): Promise<void> => {
  await db.prisma.role.create({
    data: {
      id,
      code,
      name: code,
      superAdmin: false,
      builtin: false,
      dataScope: 'ALL',
      createdAt: now,
      updatedAt: now,
    },
  });
};

describe('schema 隔离', () => {
  let a: TestDb;
  let b: TestDb;

  beforeAll(async () => {
    [a, b] = await Promise.all([setupTestDb(), setupTestDb()]);
  });

  afterAll(async () => {
    await Promise.all([a.cleanup(), b.cleanup()]);
  });

  it('should_create_tables_in_own_schema_when_test_db_is_set_up', async () => {
    expect(a.schema).not.toBe('public');
    const rows = await a.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.tables
      WHERE table_schema = ${a.schema} AND table_name = 'sys_user'`;
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('should_resolve_raw_sql_to_own_schema_when_search_path_is_set', async () => {
    const rows = await a.prisma.$queryRaw<{ s: string }[]>`SELECT current_schema() AS s`;
    expect(rows[0]?.s).toBe(a.schema);
  });

  it('should_not_see_rows_of_other_schema_when_two_schemas_share_one_database', async () => {
    await insertRole(a, '00000000-0000-7000-8000-000000000001', 'ONLY_IN_A');

    expect(await a.prisma.role.count({ where: { code: 'ONLY_IN_A' } })).toBe(1);
    expect(await b.prisma.role.count({ where: { code: 'ONLY_IN_A' } })).toBe(0);
    const raw = await b.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM sys_role WHERE code = 'ONLY_IN_A'`;
    expect(Number(raw[0]?.n)).toBe(0);
  });
});
