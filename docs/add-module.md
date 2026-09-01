# 加一个业务模块

> 从 CLAUDE.md 拆出来的操作手册 —— 它是流程不是约束,
> 只在真的加模块时才需要读,不必每次会话都占用上下文。

照抄 user/role。**一个文件建完就跑一次 `pnpm typecheck`**,绿了再建下一个。

先问清五件事:实体单数名与中文名 / 字段清单(类型、必填、唯一、可空)/
枚举值域与中文标签 / 要不要行级数据权限 / 权限码粒度。

**九个文件**(`<name>` = camelCase 单数,表名 `biz_` + 单数,路由前缀用复数):

```
contracts/src/<name>.ts                                <=120 行
server/src/domain/<name>/<name>.types.ts                   <=75
server/src/domain/<name>/<name>.repository.ts              <=45
server/src/domain/<name>/<name>.errors.ts                  <=20
server/src/application/<name>/<name>.service.ts            <=180
server/src/infrastructure/persistence/postgres/<name>.repository.ts  <=155
server/src/interface/http/<name>.routes.ts                 <=95
server/src/application/<name>/<name>.service.test.ts
server/src/interface/http/<name>.routes.test.ts
```

**七处接线,漏一处编译不过。标 ① ② 的两组必须同轮改完:**

| 位置 | 加什么 |
|---|---|
| `prisma/schema.prisma` | model + 审计四件套 + `@unique` + `@@index`;迁移后**手写** SQL 注释 |
| `contracts/src/index.ts` | `export * from './<name>.js';` |
| ① `domain/shared/unit-of-work.ts` | `RepoBundle` 加仓储接口字段 |
| ① `infrastructure/persistence/postgres/unit-of-work.ts` | `buildRepos` 加一行 |
| ② `composition/modules.ts` | new 出 Service 填进返回值 |
| ② `interface/http/app.ts` | import 路由 + `AppDeps` 加字段 + **`secured.route()`**,共三处 |
| `interface/http/wire.ts` | `to<Name>Wire`,**返回类型标注契约类型** |
| `contracts/src/permissions.ts` | 先进 `PERMISSION_GROUPS`,再加 `PERMISSIONS`。零迁移 |

建 Repository **之前**必须先改完 schema 并跑 `db:migrate`。
单聚合用不到跨仓储事务时①两行都不加 —— 但不能只加一边。

**前端四个文件**(要页面才做),菜单在 `app-shell.tsx` 的 `MENUS` 加一项带 `perm`:
`api/<name>.ts`(类型全来自契约包)/ `features/<name>/use-<name>s.ts`(queryKey 工厂 + hooks)/
`features/<name>/<name>-form-dialog.tsx`(表单 schema 独立定义)/
`routes/_app/<name>s.tsx`(放 `_app/` 下自动受保护)。

**完工门禁**:`typecheck && lint && test` 三绿、占位符清干净、每个端点挂了
`requirePermission`、列表已分页、**行级权限四个入口都做了**、写操作打了日志、
迁移 SQL 补了注释。提交前 `pnpm test:all`。
体量基准:一个聚合的 domain+wire+contracts 合计不超过约 120 行。

**常见故障**:`Property '<name>' does not exist` -> 没跑迁移 |
lint 报 R3 越界 -> domain 里 import 了契约包 | `app.test.ts` 变红 -> 路由挂到了 app 根 |
点保存没反应 -> 拿 strictObject 当表单 resolver | 列表不刷新 -> queryKey 写了字面量 |
唯一冲突只返回笼统 409 -> 去 `mapPrismaError` 登记
