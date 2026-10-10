---
name: model-project
description: 辅助用户为基于 aibase 模板的项目做数据库建模。用业务语言追问,把表名、字段、字段类型、表之间的关系(1-1 / 1-n / n-n)、主外键与删除策略、索引和唯一约束整理成一份建模文件(Markdown + Mermaid ER 图),用户确认后再改 schema.prisma、生成迁移并用 Prisma Studio 核对。当用户说「建模」「设计表」「加一张表」「改表结构」「ER 图」「这个业务数据怎么存」时使用。
---

# model-project:数据库建模

**业务怎么建模由用户决定,代码由 AI 写。**
`server/prisma/schema.prisma` 是唯一真源;本 skill 的产出是一份**建模文件**,用户确认后 AI 照着改 schema。
建模文件是当时的设计决策记录,之后不与 schema 同步,结构以 schema 为准。

**开始前**:读 `LESSONS.md`;读 `server/prisma/schema.prisma`(头部的全局约定 + 现有模型)和 `CLAUDE.md` 的"数据"一节。

---

## 第 1 步 收集业务

让用户用自己的话描述业务:有哪些东西、它们之间怎么关联、怎么流转、有哪些规则。
然后**一次问完**缺的信息,只用业务语言提问:

| 要弄清的 | 这样问 |
|---|---|
| 关系基数 | 一个订单能有几个商品?一个商品能出现在几个订单里? |
| 必填 | 下订单时一定要选客户吗? |
| 删除策略 | 删除客户时,他的订单怎么办:一起删 / 不让删 / 保留订单但解除关联? |
| 唯一 | 订单号会不会重复?是全局不重复,还是同一个客户下不重复? |
| 索引 | 订单列表要按什么筛选、排序、搜索?会不会按客户查订单? |
| 枚举 | 状态有哪几种?以后会经常加吗? |
| 精度 | 金额精确到分就够吗?数量会有小数吗? |
| 快照 | 商品改价后,历史订单里的价格要跟着变吗? |

**不要问**技术词(onDelete、Cascade、@unique、索引类型),由你翻译。
用户没说清、你又必须做假设的,写进建模文件的"假设"一节,让用户确认时一并看到。

## 第 2 步 出建模文件

复制 `template.md`,写到 `docs/YYYYMMDDHHMMSS_<模块>建模.md`(时间戳用 `date +%Y%m%d%H%M%S`)。

- ER 图用 Mermaid `erDiagram`,实体用表名,连线上写中文关系名
- 每张表一张字段表,类型用下面的**业务类型**,不写 Prisma 语法
- 关系、索引、唯一约束都要写**理由**
- 固定字段(id、审计四件套)不用列

| 业务类型 | 落到 Prisma | 说明 |
|---|---|---|
| 短文本(n) | `String` | n 写进 zod 校验;PG 中 text 与 varchar 性能相同,改长度不用迁移 |
| 长文本 | `String` | |
| 整数 | `Int` | 超过 21 亿用 `BigInt` |
| 金额 | `Decimal @db.Decimal(18, 2)` | 禁止浮点 |
| 小数(p, s) | `Decimal @db.Decimal(p, s)` | |
| 是 / 否 | `Boolean @default(...)` | 必须有默认值 |
| 日期 | `DateTime @db.Date` | |
| 日期时间 | `DateTime` | UTC 存储 |
| 枚举 | `String` | 不用 Prisma enum;取值清单写进 domain 的 `as const` 数组 |
| JSON | `Json` | 必须写为什么不拆字段 |
| 引用 X | 外键 `xId` + `@relation` | |

## 第 3 步 自查

先跑脚本检查建模文件是否填完整(状态、业务描述、ER 图与实体对应、字段行完整、枚举取值、关系的删除策略与理由、索引理由、模板占位符):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check.mjs" doc docs/<建模文件>.md
```

有 `[FAIL]` 必须改到通过。然后按下面的清单过一遍脚本查不到的语义问题,不符合的改掉;确有理由例外的,在建模文件里写明。

**基座约定**
- [ ] 表名前缀 `biz_`(业务)/ `sys_`(系统),`@@map` 指定;模型名 PascalCase,字段名 camelCase
- [ ] `id String @id`(UUID v7,应用层生成),不用自增
- [ ] 审计四件套 `createdAt / updatedAt / createdBy / updatedBy`,业务表 `createdBy` 非空;不用 `@default(now())` / `@updatedAt`
- [ ] 没有 `deletedAt` / `isDeleted`,"停用"用状态字段
- [ ] 枚举用 `String`;金额是 `Decimal`

**关系与外键**
- [ ] 关系都写成 `@relation`,数据库建外键
- [ ] 删除策略默认 Restrict(不让删);用户明确说"一起删"才 Cascade;"解除关联"用 SetNull,外键必须可空
- [ ] 跨模块引用一律 Restrict
- [ ] n-n 用显式中间表,联合主键(和 `sys_user_role` 同一做法)
- [ ] 每个外键列有索引;已是主键 / 唯一约束 / 其他索引的第一列时不重复建

**唯一与索引**
- [ ] "不能重复"用数据库唯一约束,不在代码里先查后插
- [ ] 每个索引都对应一个具体的查询场景;没有被另一个索引前缀完全覆盖的重复索引

## 第 4 步 用户确认

告诉用户建模文件的路径(Windows 上 `code <文件>` 后按 Ctrl+Shift+V 预览,能看到 ER 图;GitLab 上也能直接显示),
附一段话:几张表、关键关系与删除策略、做了哪些假设。

**询问用户是否确认。** 有修改意见就改文件,改到用户明确确认为止。确认后把文件里的状态改成"已确认(确认人, 日期)"。
**没有用户确认,不进入第 5 步。**

## 第 5 步 落地

1. 按建模文件改 `server/prisma/schema.prisma`:新模型放在对应的分区注释下。
   **每个模型、每个字段(含 id 与审计字段)都写 `///` 注释**,内容取自建模文件的业务名与说明,写业务口径与 Why,不复述字段名。
   `///` 是表结构说明的唯一真源,`pnpm db migrate` 会自动把它写进数据库(COMMENT ON),不要手写注释 SQL
2. 检查 schema 是否符合基座约定(表名前缀、id、审计字段、软删、Float、Prisma enum、onDelete 显式、外键索引覆盖、/// 注释齐全),有 `[FAIL]` 改到通过再迁移:
   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/check.mjs" schema
   ```
3. `pnpm db migrate --name <改了什么>`(只能在 `_dev` schema 上执行)
4. 读生成的 `server/prisma/migrations/<时间>_<名>/migration.sql`:
   - 只有预期的 CREATE / ALTER;出现 DROP、改类型、`NOT NULL` 加在已有列上,停下来向用户说明影响并确认
   - 不能出现写死的 `"public".`
5. `pnpm typecheck`

## 第 6 步 核对

`pnpm db studio`,打开 `http://localhost:5555/#schema=<DATABASE_SCHEMA>&view=schema`(默认显示 public,要切到项目的 schema),
用 Visualizer 核对表、字段、外键连线与建模文件一致。
把建模文件状态改成"已落地(迁移名)",再跑一次一致性核对(建模文件里的表、模型名、字段在 schema 中都存在):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check.mjs" schema --doc docs/<建模文件>.md
```

通过后按 `docs/add-module.md` 写业务代码。

---

## 修改已有表

建模文件里加"变更与影响"一节,逐项写:

| 变更 | 要写清 |
|---|---|
| 删表、删字段、改类型 | 破坏性,影响哪些数据和代码;必须用户确认 |
| 可空改必填、新增必填字段 | 已有数据用什么值填 |
| 新增或修改唯一约束 | 现有数据有没有重复(先查) |
| 改删除策略 | 对已有数据和业务代码的影响 |

## 失败处理与积累经验

- `pnpm db migrate` 报错先读原因,不要换成 `prisma migrate dev` 或 `db push`
- 允许在本 skill 的 `tmp/` 目录写临时脚本与文件(查数据、试 SQL 等),不改 schema 之外的数据库对象
- 问题解决后在 `LESSONS.md` 追加:**现象 -> 原因 -> 处理**

## 绝不做

- 不替用户决定业务语义(关系基数、删除策略、唯一规则、枚举取值)
- 没有用户确认不改 schema
- 不在 `_dev` 以外的 schema 上执行 migrate / reset
- 不用 `prisma db push`、`prisma migrate dev`
