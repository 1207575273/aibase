#!/usr/bin/env node
/**
 * model-project 检查脚本(零依赖)。
 *
 *   node check.mjs doc <建模文件>        建模文件是否填完整
 *   node check.mjs schema [--project-dir P] [--doc <建模文件>]
 *                                         schema.prisma 是否符合基座约定;带 --doc 且文件状态为"已落地"时,
 *                                         再核对建模文件里的表和字段在 schema 中都存在
 *
 * 输出 [FAIL] / [WARN] 逐条列出;有 FAIL 时退出码 1。
 * schema 按 prisma format 之后的格式解析(一行一个字段),不处理任意手写排版。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const problems = [];
const fail = (where, msg) => problems.push({ level: 'FAIL', where, msg });
const warn = (where, msg) => problems.push({ level: 'WARN', where, msg });

const AUDIT = ['createdAt', 'updatedAt', 'createdBy', 'updatedBy'];
const SOFT_DELETE = /^(deletedAt|isDeleted|deleted|removedAt)$/;
const MONEY_NAME = /(amount|price|fee|money|cost|total|subtotal|balance)$/i;
const TEMPLATE_LEFTOVER = /<模块>|<表>|<业务名>|<Model>|<用户原话>|biz_a\b|biz_b\b|"关系名"/;

// ------------------------------------------------------------------ 建模文件

/** 解析 Markdown 表格: 返回 { header, rows },rows 为字符串数组。 */
const parseTable = (lines) => {
  const rowsRaw = lines.filter((l) => l.trim().startsWith('|'));
  if (rowsRaw.length < 2) return null;
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  return { header: cells(rowsRaw[0]), rows: rowsRaw.slice(2).map(cells).filter((r) => r.some((c) => c !== '')) };
};

/** 按 "## " / "### " 切分章节。 */
const splitSections = (text, level) => {
  const re = new RegExp(`^${'#'.repeat(level)} (.+)$`, 'gm');
  const heads = [...text.matchAll(re)];
  return heads.map((m, i) => ({ title: m[1].trim(), body: text.slice(m.index + m[0].length, heads[i + 1]?.index ?? text.length) }));
};

export const readDoc = (file) => {
  const text = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const h2 = Object.fromEntries(splitSections(text, 2).map((s) => [s.title, s.body]));
  const status = /^- 状态:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  const intent = /^- 业务描述:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? '';
  const mermaid = /```mermaid\s*\n\s*erDiagram([\s\S]*?)```/.exec(text)?.[1] ?? null;
  const entities = splitSections(h2['实体'] ?? '', 3).map((s) => {
    const table = /^(\S+)/.exec(s.title)?.[1] ?? '';
    const model = /模型\s*([A-Za-z]\w*)/.exec(s.title)?.[1] ?? null;
    return { title: s.title, table, model, fields: parseTable(s.body.split('\n')) };
  });
  return { text, h2, status, intent, mermaid, entities };
};

const checkDoc = (file) => {
  const where = path.basename(file);
  const doc = readDoc(file);

  if (!/^(待确认|已确认|已落地)/.test(doc.status)) fail(where, '缺少状态,应为 待确认 / 已确认(确认人, 日期)/ 已落地(迁移名)');
  if (doc.intent === '' || doc.intent.includes('<')) fail(where, '业务描述为空(要写用户原话)');
  if (TEMPLATE_LEFTOVER.test(doc.text)) fail(where, '还有模板占位符没替换');
  if (/^\s*\d+\.\s*$/m.test(doc.h2['假设'] ?? '')) fail(where, '"假设"里有空条目;没有假设就删掉这一节');

  if (doc.mermaid === null) fail(where, '缺少 Mermaid erDiagram');
  if (doc.entities.length === 0) fail(where, '"实体"一节没有任何表');

  const entityTables = new Set(doc.entities.map((e) => e.table));
  if (doc.mermaid !== null) {
    const erTables = new Set([...doc.mermaid.matchAll(/^\s*(\w+)\s+[|}o][|o]--[|o{][|o{]\s+(\w+)/gm)].flatMap((m) => [m[1], m[2]]));
    for (const t of erTables) if (!entityTables.has(t) && !t.startsWith('sys_')) fail(where, `ER 图里的 ${t} 在"实体"里没有对应章节`);
    for (const t of entityTables) {
      if (!erTables.has(t) && !new RegExp(`^\\s*${t}\\s*\\{`, 'm').test(doc.mermaid)) warn(where, `${t} 没有出现在 ER 图里`);
    }
  }

  for (const e of doc.entities) {
    const at = `${where} / ${e.table}`;
    if (!/^(biz|sys)_[a-z0-9_]+$/.test(e.table)) fail(at, '表名应为 biz_ / sys_ 前缀加小写下划线');
    if (e.model === null) fail(at, '标题里缺少"模型 XxxYyy"');
    if (e.fields === null || e.fields.rows.length === 0) {
      fail(at, '没有字段表');
      continue;
    }
    for (const row of e.fields.rows) {
      const [name, title, type] = row;
      if (!name || !title || !type) fail(at, `字段行不完整: ${row.join(' | ')}`);
      if (name && !/^[a-z][A-Za-z0-9]*$/.test(name)) fail(at, `字段名 ${name} 应为 camelCase`);
      if (type && /枚举/.test(type) && !/[A-Z_]+\s*\/\s*[A-Z_]+/.test(type)) fail(at, `枚举字段 ${name} 没列出取值`);
      if (type && /短文本(?!\s*\(\d+\))/.test(type)) warn(at, `短文本字段 ${name} 没写长度`);
      if (name && MONEY_NAME.test(name) && type && !/金额|小数/.test(type)) fail(at, `${name} 看起来是金额,类型应为 金额 或 小数`);
      if (name && SOFT_DELETE.test(name)) fail(at, `${name} 是软删字段,基座不用软删`);
    }
  }

  const relations = parseTable((doc.h2['关系'] ?? '').split('\n'));
  if (relations) {
    const col = (n) => relations.header.indexOf(n);
    for (const r of relations.rows) {
      if (!r[col('基数')]) fail(where, `关系 ${r[0]} 没写基数`);
      if (!r[col('删除时')]) fail(where, `关系 ${r[0]} 没写删除时怎么办`);
      if (!r[col('理由')]) fail(where, `关系 ${r[0]} 没写理由`);
    }
  } else if (doc.entities.length > 1) warn(where, '有多张表但没有"关系"表格');

  const indexes = parseTable((doc.h2['索引与唯一约束'] ?? '').split('\n'));
  if (indexes) {
    const reasonCol = indexes.header.findIndex((h) => h.startsWith('理由'));
    for (const r of indexes.rows) if (!r[reasonCol]) fail(where, `索引 ${r[0]} (${r[1]}) 没写理由`);
  }
  return doc;
};

// ------------------------------------------------------------------ schema.prisma

const parseSchema = (text) => {
  const models = [];
  for (const m of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const lines = m[2].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    const fields = lines
      .filter((l) => !l.startsWith('@@'))
      .map((l) => {
        const [name, type, ...rest] = l.split(/\s+/);
        return { name, type: type.replace(/[?[\]]/g, ''), optional: type.endsWith('?'), list: type.endsWith('[]'), attrs: rest.join(' ') };
      });
    const blocks = lines.filter((l) => l.startsWith('@@'));
    const cols = (kind) => blocks.filter((b) => b.startsWith(`@@${kind}(`)).map((b) => /\[([^\]]*)\]/.exec(b)[1].split(',').map((s) => s.trim()));
    models.push({
      name: m[1],
      fields,
      table: /@@map\("([^"]+)"\)/.exec(m[2])?.[1] ?? null,
      id: cols('id')[0] ?? null,
      uniques: cols('unique'),
      indexes: cols('index'),
    });
  }
  return { models, enums: [...text.matchAll(/^enum (\w+)/gm)].map((m) => m[1]) };
};

const checkSchema = (schemaFile, docFile) => {
  const where = 'schema.prisma';
  const { models, enums } = parseSchema(fs.readFileSync(schemaFile, 'utf8'));
  for (const e of enums) fail(`${where} / enum ${e}`, '不用 Prisma enum,改为 String + domain 的 as const 取值');

  for (const m of models) {
    const at = `${where} / ${m.name}`;
    const has = (n) => m.fields.find((f) => f.name === n);
    if (!m.table) fail(at, '缺少 @@map("biz_xxx" / "sys_xxx")');
    else if (!/^(biz|sys)_[a-z0-9_]+$/.test(m.table)) fail(at, `表名 ${m.table} 应为 biz_ / sys_ 前缀`);
    const isBiz = m.table?.startsWith('biz_');

    const idField = has('id');
    if (idField) {
      if (idField.type !== 'String' || !idField.attrs.includes('@id')) fail(at, 'id 应为 String @id(UUID v7)');
      if (/autoincrement|uuid\(\)|cuid\(\)/.test(idField.attrs)) fail(at, 'id 由应用层生成,不用数据库默认值');
      for (const a of AUDIT) if (!has(a)) fail(at, `缺少审计字段 ${a}`);
      if (isBiz && has('createdBy')?.optional) fail(at, '业务表 createdBy 必须非空');
    } else if (!m.id) fail(at, '没有 id,也没有 @@id 联合主键');

    for (const f of m.fields) {
      if (f.attrs.includes('@default(now())') || f.attrs.includes('@updatedAt')) fail(at, `${f.name} 不用 @default(now()) / @updatedAt,时间由注入的 Clock 写入`);
      if (SOFT_DELETE.test(f.name)) fail(at, `${f.name} 是软删字段,基座不用软删`);
      if (f.type === 'Float') fail(at, `${f.name} 不用 Float,金额与小数用 Decimal`);
      if (MONEY_NAME.test(f.name) && !f.list && ['Int', 'String', 'Float'].includes(f.type)) fail(at, `${f.name} 看起来是金额,应为 Decimal`);

      const rel = /@relation\(([^)]*)\)/.exec(f.attrs)?.[1];
      if (rel && rel.includes('fields:')) {
        const fk = /fields:\s*\[([^\]]+)\]/.exec(rel)[1].split(',').map((s) => s.trim());
        if (!/onDelete:/.test(rel)) fail(at, `${f.name} 的 @relation 没写 onDelete,删除策略必须显式决定`);
        if (/onDelete:\s*SetNull/.test(rel) && fk.some((c) => !has(c)?.optional)) fail(at, `${f.name} 用 SetNull 但外键 ${fk.join(', ')} 不可空`);
        const covered =
          [m.id, ...m.uniques, ...m.indexes].filter(Boolean).some((cols) => fk.every((c, i) => cols[i] === c)) ||
          (fk.length === 1 && has(fk[0])?.attrs.includes('@unique'));
        if (!covered) fail(at, `外键 ${fk.join(', ')} 没有索引覆盖(PG 不会自动建),加 @@index([${fk.join(', ')}])`);
      }
    }

    const all = [m.id, ...m.uniques, ...m.indexes].filter(Boolean);
    for (const idx of m.indexes) {
      const dup = all.find((o) => o !== idx && o.length >= idx.length && idx.every((c, i) => o[i] === c));
      if (dup) warn(at, `索引 [${idx.join(', ')}] 被 [${dup.join(', ')}] 的前缀覆盖,可能多余`);
    }
    if (m.fields.filter((f) => !f.list).length > 30) warn(at, '字段超过 30 个,考虑拆表');
  }

  // 建模文件已落地: 文件里的表和字段都要在 schema 里
  if (docFile) {
    const doc = readDoc(docFile);
    if (doc.status.startsWith('已落地')) {
      for (const e of doc.entities) {
        const m = models.find((x) => x.table === e.table);
        const at = `${path.basename(docFile)} / ${e.table}`;
        if (!m) {
          fail(at, 'schema 里没有这张表');
          continue;
        }
        if (e.model && m.name !== e.model) fail(at, `模型名不一致: 建模文件 ${e.model},schema ${m.name}`);
        for (const row of e.fields?.rows ?? []) {
          if (!m.fields.some((f) => f.name === row[0])) fail(at, `schema 里没有字段 ${row[0]}`);
        }
      }
    } else warn(path.basename(docFile), `状态是"${doc.status}",还没落地,跳过与 schema 的一致性核对`);
  }
};

// ------------------------------------------------------------------ 入口

const report = (label) => {
  for (const p of problems) process.stdout.write(`[${p.level}] ${p.where}: ${p.msg}\n`);
  const fails = problems.filter((p) => p.level === 'FAIL').length;
  const warns = problems.length - fails;
  process.stdout.write(`${fails > 0 ? '[FAIL]' : '[PASS]'} ${label}: ${fails} 个错误,${warns} 个警告\n`);
  process.exit(fails > 0 ? 1 : 0);
};

const [command, target] = argv;
if (command === 'doc') {
  if (!target || !fs.existsSync(target)) {
    process.stdout.write('用法: node check.mjs doc <建模文件>\n');
    process.exit(1);
  }
  checkDoc(target);
  report('建模文件检查');
} else if (command === 'schema') {
  const projectDir = path.resolve(option('project-dir') ?? '.');
  const schemaFile = path.join(projectDir, 'server', 'prisma', 'schema.prisma');
  checkSchema(schemaFile, option('doc'));
  // 注释规则只有一份,在项目的 scripts/db-comments.mjs(pnpm db migrate 与闸门测试共用),这里直接复用
  const rules = path.join(projectDir, 'scripts', 'db-comments.mjs');
  if (fs.existsSync(rules)) {
    const { parseSchemaComments, missingComments } = await import(pathToFileURL(rules).href);
    for (const m of missingComments(parseSchemaComments(fs.readFileSync(schemaFile, 'utf8')))) {
      fail('schema.prisma', `${m}(每个模型、每个字段都要有 /// 注释,它会写进数据库)`);
    }
  } else warn('schema.prisma', '项目里没有 scripts/db-comments.mjs(旧版模板),跳过 /// 注释齐全检查');
  report('schema 检查');
} else {
  process.stdout.write('用法: node check.mjs doc <建模文件> | node check.mjs schema [--project-dir P] [--doc <建模文件>]\n');
  process.exit(1);
}
