# 加一个业务模块

> 从 CLAUDE.md 拆出来的操作手册 —— 它是流程不是约束,
> 只在真的加模块时才需要读,不必每次会话都占用上下文。

照抄 `server/src/modules/identity` 里 role 的那一套。**一个文件建完就跑一次 `pnpm typecheck`**,绿了再建下一个。

先问清五件事:实体单数名与中文名 / 字段清单(类型、必填、唯一、可空)/
枚举值域与中文标签 / 要不要行级数据权限 / 权限码粒度。

**九个文件**(`<name>` = camelCase 单数,模块目录用 kebab-case,表名 `biz_` + 单数,路由前缀用复数):

```
packages/contracts/src/<name>.ts                                 <=120 行
server/src/modules/<name>/domain/<name>.types.ts                 <=75
server/src/modules/<name>/domain/<name>.repository.ts            <=45
server/src/modules/<name>/domain/<name>.errors.ts                <=20
server/src/modules/<name>/application/<name>.service.ts          <=180
server/src/modules/<name>/infra/<name>.repository.ts             <=155
server/src/modules/<name>/interfaces/http/<name>.routes.ts       <=95
server/src/modules/<name>/application/<name>.service.test.ts
server/src/modules/<name>/interfaces/http/<name>.routes.test.ts
```

外加本模块的 `interfaces/http/wire.ts`(`to<Name>Wire`,**返回类型标注契约类型**)。

**接线,漏一处编译不过。标 ① ② 的两组必须同轮改完:**

| 位置 | 加什么 |
|---|---|
| `server/prisma/schema.prisma` | model + 审计四件套 + `@unique` + `@@index`;迁移后**手写** SQL 注释,**不许写死 `"public".`** |
| `packages/contracts/src/index.ts` | `export * from './<name>.js';` |
| ① `server/src/composition/repos.ts` | `RepoBundle` 加字段 + `buildRepos` 加一行 |
| ② `server/src/composition/modules.ts` | new 出 Service 填进返回值 |
| ② `server/src/composition/app.ts` | import 路由 + `AppDeps` 加字段 + **`secured.route()`**,共三处 |
| `packages/contracts/src/permissions.ts` | 先进 `PERMISSION_GROUPS`,再加 `PERMISSIONS`。零迁移 |

建 Repository **之前**必须先改完 schema 并跑 `pnpm db migrate --name <改了什么>`(只能在开发 schema 上跑,会自动生成迁移、应用并重新生成 Client)。
单聚合用不到跨仓储事务时 ① 可以不加;要事务时 service 在 deps 里声明
`UnitOfWork<{ <name>: <Name>Repository }>`,并在 ① 登记。

跨模块只准 import 对方的 `domain`(类型与仓储接口),实现由 composition 注入。
lint 报 R2 说明碰了别模块的 application / infra / interfaces。

**前端四个文件**(要页面才做),菜单在 `app-shell.tsx` 的 `MENUS` 加一项带 `perm`:
`api/<name>.ts`(类型全来自契约包)/ `features/<name>/use-<name>s.ts`(queryKey 工厂 + hooks)/
`features/<name>/<name>-form-dialog.tsx`(表单 schema 独立定义)/
`routes/_app/<name>s.tsx`(放 `_app/` 下自动受保护)。

**照抄样板**:列表页抄 `routes/_app/users.tsx`,表单弹窗抄 `features/system/user-form-dialog.tsx`,
数据 hooks 抄 `features/system/use-system.ts`。

**只用已有组件**:`web/src/components/ui/` 下的 shadcn 组件(button / input / textarea / select / checkbox /
radio-group / switch / label / dialog / sheet / popover / tooltip / dropdown-menu / tabs / table / pagination /
card / badge / separator / skeleton / sonner)。**不要现场 `shadcn add`**(沙箱可能连不上组件仓库),
也不要引其他 UI 库;日期用原生 `<Input type="date">`。
日期与数字展示一律用 `lib/format.ts`(按 Asia/Shanghai,空值显示 `-`),不要在页面里各写一份。

**完工门禁**:`typecheck && lint && test` 三绿、占位符清干净、每个端点挂了
`requirePermission`、列表已分页、**行级权限四个入口都做了**、写操作打了日志、
迁移 SQL 补了注释。提交前 `pnpm verify`。
体量基准:一个聚合的 domain+wire+contracts 合计不超过约 120 行。

**常见故障**:`Property '<name>' does not exist` -> 没跑迁移 |
lint 报 R3 越界 -> domain / application 里 import 了契约包 | `composition/app.test.ts` 变红 -> 路由挂到了 app 根 |
点保存没反应 -> 拿 strictObject 当表单 resolver | 列表不刷新 -> queryKey 写了字面量 |
唯一冲突只返回笼统 409 -> 去 `platform/db/prisma-error.ts` 的 `mapPrismaError` 登记 |
迁移门禁红 -> 迁移 SQL 里有 `"public".`,删掉 schema 前缀
