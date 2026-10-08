/**
 * 表 / 字段注释: schema.prisma 的 /// 是唯一真源,数据库里的 COMMENT 由它生成并与它保持一致。
 *
 * 为什么需要: Prisma 的 /// 只进生成的 TS 类型,不进数据库(prisma/prisma#8703,2021 年至今未支持)。
 *   而 AI、运维、BI 常常直接连库看表结构,拿不到 schema 文件。注释必须落到 PG 的 COMMENT 上,
 *   又不能让人手写两遍(必然漂移)。
 *
 * 谁在用:
 *   - pnpm db migrate: 生成迁移前检查 /// 是否齐全;再把"schema 与当前库不一致"的注释追加进本次迁移
 *   - server/tests/db-comments.test.ts: 按迁移从零建库,断言库里的注释与 schema 逐条一致
 *
 * 解析按行进行,不引 @prisma/internals: schema 由 prisma format 排版,结构规整;
 * 关系字段(类型是另一个 model)没有对应的列,跳过;@map / @@map 按映射后的名字落库。
 */

/** 只有三斜线是文档注释;两斜线是给读 schema 的人看的,不采集。 */
const DOC_PREFIX = '///';

const sqlLiteral = (text) => `'${text.replaceAll("'", "''")}'`;
const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * @param {string} text schema.prisma 内容
 * @returns {{name:string, table:string|null, doc:string, fields:{name:string, column:string, doc:string}[]}[]}
 */
export const parseSchemaComments = (text) => {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const modelNames = new Set(lines.map((l) => /^model\s+(\w+)\s*\{/.exec(l)?.[1]).filter(Boolean));
  const models = [];
  let current = null;
  let doc = [];

  for (const line of lines) {
    if (line.startsWith(DOC_PREFIX)) {
      // 去掉 /// 与紧跟的一个空格,保留其后的缩进(多行注释里的对齐是有意的)
      doc.push(line.slice(DOC_PREFIX.length).replace(/^ /, ''));
      continue;
    }
    const start = /^model\s+(\w+)\s*\{/.exec(line);
    if (start) {
      current = { name: start[1], table: null, doc: doc.join('\n'), fields: [] };
      doc = [];
      continue;
    }
    if (current === null) {
      doc = []; // model 之外(generator / datasource / 文件头)的注释不属于任何表
      continue;
    }
    if (line === '' || line.startsWith('//')) continue; // 空行与 // 注释不打断紧挨着的 ///
    if (line === '}') {
      models.push(current);
      current = null;
      doc = [];
      continue;
    }
    const mapped = /^@@map\("([^"]+)"\)/.exec(line);
    if (mapped) current.table = mapped[1];
    if (line.startsWith('@@')) {
      doc = [];
      continue;
    }
    const [name, rawType] = line.split(/\s+/);
    if (name && rawType && !modelNames.has(rawType.replace(/[?[\]]/g, ''))) {
      current.fields.push({ name, column: /@map\("([^"]+)"\)/.exec(line)?.[1] ?? name, doc: doc.join('\n') });
    }
    doc = [];
  }
  return models;
};

/** 缺注释的位置,如 "User -> 表缺 /// 注释"、"User.status -> 字段缺 /// 注释"。 */
export const missingComments = (models) =>
  models.flatMap((m) => [
    ...(m.table ? [] : [`${m.name} -> 缺 @@map("表名")`]),
    ...(m.doc.trim() ? [] : [`${m.name} -> 表缺 /// 注释`]),
    ...m.fields.filter((f) => !f.doc.trim()).map((f) => `${m.name}.${f.name} -> 字段缺 /// 注释`),
  ]);

/** schema 期望的注释,键为 "表" 或 "表.列"。 */
export const expectedComments = (models) =>
  new Map(models.flatMap((m) => [[m.table, m.doc], ...m.fields.map((f) => [`${m.table}.${f.column}`, f.doc])]));

/**
 * 只为与当前库不一致的对象生成 COMMENT ON(COMMENT ON 是覆盖写,天然幂等)。
 * @param {Map<string, string|null>} current 当前库里的注释,键同 expectedComments
 */
export const commentStatements = (models, current) => {
  const out = [];
  for (const m of models) {
    if (current.get(m.table) !== m.doc) out.push(`COMMENT ON TABLE ${quoteIdent(m.table)} IS ${sqlLiteral(m.doc)};`);
    for (const f of m.fields) {
      if (current.get(`${m.table}.${f.column}`) !== f.doc) {
        out.push(`COMMENT ON COLUMN ${quoteIdent(m.table)}.${quoteIdent(f.column)} IS ${sqlLiteral(f.doc)};`);
      }
    }
  }
  return out;
};

/** 读某个 schema 下全部表与列的注释;参数 $1 = schema 名。结果交给 toCommentMap。 */
export const COMMENTS_QUERY = `
  SELECT c.relname AS "table", NULL::text AS "column", obj_description(c.oid, 'pg_class') AS "comment"
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relkind = 'r'
  UNION ALL
  SELECT c.relname, a.attname, col_description(c.oid, a.attnum)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE n.nspname = $1 AND c.relkind = 'r'`;

/** @param {{table:string, column:string|null, comment:string|null}[]} rows */
export const toCommentMap = (rows) => new Map(rows.map((r) => [r.column ? `${r.table}.${r.column}` : r.table, r.comment]));
