/**
 * 表 / 字段注释的护栏: schema.prisma 的 /// 是唯一真源,数据库里的 COMMENT 必须与它逐条一致。
 *
 * 闸门那组用例按迁移从零建一个临时 schema 再比对 —— 测的是"迁移文件最终落到库里的注释",
 * 漏追加 COMMENT ON、手改过迁移、改了 /// 却没生成迁移,都会在这里红。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMENTS_QUERY,
  commentStatements,
  expectedComments,
  missingComments,
  parseSchemaComments,
  toCommentMap,
  // @ts-expect-error 纯 JS 模块,无类型声明;pnpm db migrate 与本测试共用
} from '../../scripts/db-comments.mjs';
import { setupTestDb, type TestDb } from './helpers/test-db.js';

interface Field {
  name: string;
  column: string;
  doc: string;
}
interface Model {
  name: string;
  table: string | null;
  doc: string;
  fields: Field[];
}

const parse = parseSchemaComments as (text: string) => Model[];
const SCHEMA_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma/schema.prisma');

const SAMPLE = `
// 文件头的普通注释,不属于任何表
generator client {
  provider = "prisma-client"
}

/// 订单
model Order {
  /// 主键
  id         String   @id
  /// 下单客户,删客户时不让删
  customerId String   @map("customer_id")
  customer   Customer @relation(fields: [customerId], references: [id], onDelete: Restrict)
  // 普通注释不打断上面的 ///
  remark     String?
  items      OrderItem[]

  @@map("biz_order")
}

/// 客户
model Customer {
  /// 主键
  id     String  @id
  orders Order[]

  @@map("biz_customer")
}

/// 订单明细
model OrderItem {
  /// 主键
  id String @id

  @@map("biz_order_item")
}
`;

describe('parseSchemaComments', () => {
  it('should_skip_relation_fields_when_type_is_a_model', () => {
    const [order, customer] = parse(SAMPLE);
    expect(order?.fields.map((f) => f.name)).toEqual(['id', 'customerId', 'remark']);
    expect(customer?.fields.map((f) => f.name)).toEqual(['id']);
  });

  it('should_use_mapped_names_when_map_is_present', () => {
    const [order] = parse(SAMPLE);
    expect(order?.table).toBe('biz_order');
    expect(order?.fields.find((f) => f.name === 'customerId')?.column).toBe('customer_id');
  });

  it('should_keep_line_breaks_when_doc_spans_multiple_lines', () => {
    const [model] = parse('/// 第一行\n///   缩进的第二行\nmodel A {\n  id String @id\n  @@map("a")\n}');
    expect(model?.doc).toBe('第一行\n  缩进的第二行');
  });

  it('should_report_missing_when_table_or_field_has_no_doc', () => {
    const models = parse(SAMPLE);
    expect(missingComments(models)).toEqual(['Order.remark -> 字段缺 /// 注释']);
  });
});

describe('commentStatements', () => {
  it('should_emit_only_changed_comments_when_some_already_match', () => {
    const models = parse('/// 表\nmodel A {\n  /// 旧的\n  id String @id\n  /// 名字\n  name String\n  @@map("a")\n}');
    const current = new Map([
      ['a', '表'],
      ['a.id', '不一样'],
    ]);
    expect(commentStatements(models, current)).toEqual([
      `COMMENT ON COLUMN "a"."id" IS '旧的';`,
      `COMMENT ON COLUMN "a"."name" IS '名字';`,
    ]);
  });

  it('should_escape_single_quotes_when_doc_contains_them', () => {
    const models = parse("/// it's\nmodel A {\n  /// x\n  id String @id\n  @@map(\"a\")\n}");
    expect(commentStatements(models, new Map([['a.id', 'x']]))).toEqual([`COMMENT ON TABLE "a" IS 'it''s';`]);
  });
});

describe('schema.prisma 与数据库注释一致', () => {
  const models = parse(readFileSync(SCHEMA_FILE, 'utf8'));
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('should_have_doc_comment_when_model_or_column_exists', () => {
    expect(missingComments(models)).toEqual([]);
  });

  it('should_match_schema_docs_when_database_is_built_from_migrations', async () => {
    const rows = await db.prisma.$queryRawUnsafe<{ table: string; column: string | null; comment: string | null }[]>(
      COMMENTS_QUERY,
      db.schema,
    );
    const actual = toCommentMap(rows) as Map<string, string | null>;
    const expected = expectedComments(models) as Map<string, string>;
    const mismatched = [...expected].filter(([key, doc]) => actual.get(key) !== doc).map(([key]) => key);
    // 失败时列出不一致的对象: 改了 /// 后执行 pnpm db migrate --name <说明> 生成注释迁移
    expect(mismatched).toEqual([]);
  });
});
