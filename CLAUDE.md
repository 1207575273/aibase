# 项目开发指令

> 每次会话自动加载,只写约束。理由在对应代码文件的头注释里;通用偏好见 `~/.claude/CLAUDE.md`。

## 一、结构

Node.js 业务模板:认证、RBAC、行级数据权限、分页、事务、日志已就位。`identity` 模块(登录 / 用户 / 角色)是抄写样板。

```
server/    后端 Hono + Prisma        web/      前端 React + shadcn        packages/contracts  前后端共享 zod 契约
e2e/       端到端                   deploy/   镜像与 compose              scripts/  开发命令      docs/  文档
```

- `server/src`:`main.ts` / `composition/`(装配,唯一知道全部模块)/ `platform/`(config、db、logger、http)/
  `lib/`(纯函数)/ `modules/<m>/{domain,application,infra,interfaces/http}`
- 一个模块 = `packages/contracts/src/<m>.ts` + `server/src/modules/<m>/` + `web/src/features/<m>/`,步骤见 `docs/add-module.md`
- 端口按项目分段(本模板 71xx),只在 `.env` 改

## 二、命令

```bash
pnpm install && cp .env.example .env   # 填 DATABASE_URL / DATABASE_SCHEMA
pnpm dev / pnpm kill                   # 起停后端 + 前端(不会自动拉起数据库)
pnpm db up / pnpm db down              # 起停本机开发库(有 .devdb/ 是嵌入式库,沙箱重启后先 up)
pnpm db migrate --name <改了什么>       # 改完 schema.prisma:生成迁移、应用、重新生成 Client
pnpm db deploy / pnpm db seed          # 应用迁移 / 灌种子(admin / admin12345)
pnpm typecheck                         # 每建完一个文件跑一次
pnpm verify                            # 提交前:typecheck + lint + build + test + e2e
pnpm --filter @app/server exec vitest run <文件>   # 只跑一个测试文件
```

## 三、技术栈

版本精确锁定,升级单独提交。Node ≥22.12 · Hono · Prisma 7.10 + adapter-pg · PostgreSQL 17 · zod 4 · vitest 4 · pino ·
React 19 · vite · TanStack Router/Query · Tailwind v4 · shadcn/ui · react-hook-form · axios。

- Prisma 的 `prisma` / `@prisma/client` / `@prisma/adapter-pg` 三包同版本一起升,不要用 `@latest`
- typescript 不能升 7(`@typescript-eslint/parser` 的 peer 上限)

## 四、硬约束

**分层**(eslint 守着,违规时报错信息即说明;改目录或加规则必须做注入探针)
- 模块内 `interfaces -> application -> domain`,infra 实现 domain 定义的接口;domain 零 IO
- 跨模块只引对方 domain;只有 interfaces 与 platform/http 能引契约;`process.env` 只在 `platform/config`
- 装配只在 `composition/`,加业务不改 `main.ts`;不搞 CQRS,一个聚合一个 Service
- 路径用 `config.REPO_ROOT`,不要用 `import.meta.url` 数层级

**HTTP**
- 只用 GET / POST,写操作动词在 URL:`POST /users/:id/update`;固定路径注册在 `/:id` 之前
- 列表必须分页(默认 20,上限 100);校验用 `validate()` 不用 `zValidator`;handler 不写 try/catch

**数据**
- 唯一性靠 DB 约束 + P2002 翻译,禁止 check-then-act;不用 `deletedAt` 软删
- 时间由注入的 Clock 产生(禁 `@default(now())` / `@updatedAt`),ID 用 UUID v7;存 UTC,按 Asia/Shanghai 展示
- 业务表必须有 `createdAt/updatedAt/createdBy/updatedBy`,业务表 `createdBy` 非空
- 数据库由人配置:`DATABASE_URL` + `DATABASE_SCHEMA` 必填,schema 命名 `<项目>_dev` / `_test` / `_prod`
- **每个模型、每个字段都要有 `///` 注释**(含 id 与审计字段),写业务口径与 Why,不复述字段名;
  它是表结构说明的唯一真源,`pnpm db migrate` 会把它写进库(COMMENT ON),不手写注释 SQL;
  库里注释与 schema 不一致时 `tests/db-comments.test.ts` 会失败
- 改表只用 `pnpm db migrate`,不用 `prisma migrate dev`(要建影子库,沙箱没有建库权限);
  migrate / reset 只许在 `_dev` 上执行,测试 / 生产只用 `pnpm db deploy`;迁移 SQL 不许写死 `"public".`
- AI 执行 reset 会被 Prisma 拦下,必须向人说明后果并取得明确同意,不许绕过

**契约与权限**
- 请求体 `z.strictObject`,导出类型用 `z.input`;表单 schema 与请求体 schema 分开定义
- 权限码真源 `packages/contracts/src/permissions.ts`,不建 Permission 表;每个路由逐个挂 `requirePermission`
- 行级权限列表与单条都要做,越界抛 404 不抛 403;主体显式传参 `service.method(input, actor)`,照抄 `user.service.ts`

**安全与日志**
- 登录态 JWT + `Authorization` 头,不用 Cookie;`hs256-token-signer` 的 alg 校验与 `timingSafeEqual` 不能动
- 用户不存在与密码错误同码、同文案、相近耗时;`hash` / `verify` 不进循环;连接串不整条进日志
- 写操作至少打一行日志,带 `traceId` 与 `actorId`

**前端**
- 只用 `web/src/components/ui` 下已有组件,不要现场 `shadcn add`,不引其他 UI 库;日期与数字用 `lib/format.ts`
- 业务层不直接 import axios,走 `api/http.ts`;不硬编码路径前缀,用 `import.meta.env.BASE_URL`;`<Can>` 只控显隐

**测试**
- 连真实 PostgreSQL,不用 `vi.mock`;每个测试文件一个临时 schema(`setupTestDb()`)
- 命名 `should_<行为>_when_<前置>`;断错误只断 `code` 不断 message
- `composition/app.test.ts` 是全站护栏(匿名全 401、零权限全 403),改动后必须做注入探针

## 五、不做(不要重新评估)

Cookie 会话 · Permission 表 / 通配符权限码 · 菜单表与动态路由 · 多租户 · DI 容器 · 重组件库 · 前端密码加密 ·
OAuth / SSO / MFA · 审计日志表 · 状态管理库

## 六、协作

改动前先给方案,等确认再写代码。先问再做:引新依赖、改 domain 接口、跨层调用、绕过 Repository、在 composition 之外装配。
