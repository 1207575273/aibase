# 项目开发指令

> 每次会话自动加载。**只写约束与结论**,展开的理由在对应代码文件的头注释里 ——
> 要改某条约束,先去读那个文件。通用编码偏好见 `~/.claude/CLAUDE.md`。

## 一、项目是什么

Node.js 通用业务模板。认证鉴权、分页、审计、事务、错误处理都已就位,
自带**用户 / 角色**两套 CRUD 作示范,含行级数据权限与配套测试 —— 抄的时候一起抄。

```
server/    后端(按模块组织,模块内轻量 DDD 四层)   web/     前端 SPA
packages/  共享包(contracts: 前后端共享契约)         e2e/     端到端(起真进程)
deploy/    Dockerfile / compose / nginx              scripts/ 开发脚本   docs/ 项目文档
```

一个业务模块落在三处:`packages/contracts/src/<模块>.ts`、`server/src/modules/<模块>/`、
`web/src/features/<模块>/`。加服务在一级加目录,加共享库放 `packages/` 下。

### 端口 —— clone 后先定这几个

端口按项目分段(本模板 `71xx`)。**一台机器跑多个项目是常态,不分段必撞**,
撞了的症状是"连上了但表都不对",比连不上难查。

| 端口 | 用途 | 配在哪 | 换项目 |
|---|---|---|---|
| 7101 | 服务入口:开发是后端、生产是 nginx(同号,不用记两套) | `.env` `PORT` | **必改** |
| 7102 | 前端 dev server | `.env` `WEB_PORT` | **必改** |
| 7103 | [可选] 本机开发库,`pnpm db up` 手动起 | `docker-compose.dev.yml` + `.env` `DATABASE_URL` | 用到才改 |
| 7104 | 测试环境入口(类生产预演) | `docker-compose.test.yml` | 必改 |
| 8101 | e2e,由 `PORT+1000` 派生 | 不用配 | 否 |

改 `.env` 一处生效(后端、vite、开发脚本、e2e 同源)。临时换端口:`PORT=8080 pnpm dev`。
**不要再引入独立端口文件** —— 试过 `ports.json`,读它 5 处、绕过它硬编码 6 处,实锤漂移两次。

## 二、技术栈

版本**精确锁定**(无 `^` `~`),升级走单独 commit。

Node ≥22.12、hono 4.13.5、zod 4.4.3、vitest 4.1.11、esbuild 0.28.2、pino 10.3.1 |
Prisma 7.10.0 + adapter-pg + PostgreSQL 17 | React 19.2.8、vite 8.2.2、
TanStack Router/Query、Tailwind v4、shadcn/ui(源码在 `web/src/components/ui/`,21 个)+ radix-ui、
react-hook-form、axios、lucide 图标、sonner 提示。只有浅色主题;动画只用 tw-animate-css(弹层进出场)。
**typescript 6.0.3 不能升 7**(`@typescript-eslint/parser` peer 上限 `<6.1`)。

**Prisma 别用 `@latest` 装** —— `prisma` 的 npm latest 已是 `8.0.0-rc`,与 `@prisma/client`
的 7.10.0 不匹配,postinstall 直接失败。升级要三个包(`prisma` / `@prisma/client` /
`@prisma/adapter-pg`)同版本一起动。`prisma` CLI 同时在根 devDeps 和 server deps 里
**不是重复**:后者是部署单元的运行时依赖(容器要跑 `migrate deploy`,而 `--prod` 只带 deps)。

**安全相关零第三方依赖**:scrypt / 手写 HS256。
**shadcn 不当 npm 包用** —— 组件源码已预装在仓库里,**业务开发不要现场 `shadcn add`**(沙箱可能连不上组件仓库)。
维护者补组件时注意:新版 CLI 会把 `cn` 写成 `import { cn } from "cn"` 并新增 npm 包 `cn`,
要改回 `@/lib/utils` 并删掉那个包;遇到"是否覆盖 button.tsx"一律选否。

## 三、硬约束(绝不破)

### 分层

```
server/src/
  main.ts        进程入口,不随业务增长
  composition/   装配: context / modules / repos(仓储清单)/ app(路由总装 + 全站护栏测试)
  platform/      横切基础设施: config / db / logger / http(错误出口、校验、requirePermission)
  lib/           纯类型与纯函数: app-error / clock / page / actor / unit-of-work 端口 ...
  modules/<m>/   业务模块: domain / application / infra / interfaces/http
```

模块内 `interfaces -> application -> domain`,infra 实现 domain 定义的接口。
domain 只放类型 + 接口 + 纯函数,零 IO;业务逻辑在 application。
自带一个模块 `identity`(登录 / 用户 / 角色),是加模块的抄写样板。

边界由 eslint 守着:R0 lib 只依赖 lib、platform 不依赖业务模块 / R1 domain 只依赖 lib 与 domain /
R1b application 不依赖 infra、interfaces、platform / R2 跨模块只走对方 domain /
R3 只有 interfaces 与 platform/http 能 import 契约 / R4 禁裸读 `process.env` /
R5 前端业务层禁 import axios。**加规则或调整目录都必须做注入探针**(写一行违规代码确认真报错)。

### 代码组织

- **不搞 CQRS**,读写都走 Repository
- **一个聚合一个 Service**。方法超 ~80 行 / 需独占依赖 / 跨聚合事务,满足任一才拆 usecase
- 装配在 `composition/`(modules.ts 建服务、repos.ts 登记仓储、app.ts 挂路由),**加业务不改 main.ts**
- 事务: service 在 deps 里声明 `UnitOfWork<{ 要用的仓储 }>`,全量清单只在 `composition/repos.ts`

### HTTP

- **只用 GET / POST**。读 GET+query,写 POST 且动词在 URL 里:`POST /users/:id/update`
- **固定路径必须注册在 `/:id` 之前**
- **任何列表端点都必须分页**(默认 20 上限 100),Repository 不许有返回全量数组的方法
- 校验用 `validator.ts` 的 `validate()`,**不要直接用 `zValidator`**(绕过统一出口)
- 路由 handler **不写 try/catch**,全站一个 `AppError` + 一个 `app.onError`
- `main.ts` 的 root 也要挂 `handleNotFound`/`handleError`(Hono 子 app 的 notFound 不生效)

### 数据

- **唯一性靠 DB 约束 + P2002 翻译,禁止 check-then-act**
- 时间**一律由注入的 Clock 产生**,禁 `@default(now())`/`@updatedAt`;ID 用 IdGenerator(UUID v7)
- 存储 UTC,展示与按日聚合用 Asia/Shanghai,转换只在 wire 层;"哪一天"存 `YYYY-MM-DD` 字符串
- 业务表必须有 `createdAt/updatedAt/createdBy/updatedBy`,业务表 `createdBy` **非空**
  (行级权限的锚点)。系统表 `sys_` 可空,**这些无主行对 `dataScope=SELF` 不可见**
- **不用 `deletedAt` 软删**,状态用业务字段表达
- **数据库由人配置,模板不自动拉起**:`DATABASE_URL` + `DATABASE_SCHEMA` 都必填,schema 按环境加前缀
  后缀 `<项目>_dev` / `_test` / `_prod`,同一项目的几套环境在库里排在一起(不符合只告警)。沙箱是容器,起不了容器,库由平台提供。沙箱里多个项目共用一个 PG,
  迁移与运行时读同一个变量。**迁移 SQL 禁止写死 `"public".`**(`tests/migrations-schema-agnostic.test.ts` 拦)
- **改表只用 `pnpm db migrate --name <改了什么>`**:内部用 `prisma migrate diff` 生成迁移并应用、重新生成 Client。
  不用 `prisma migrate dev`(要建影子库,沙箱的共享 PG 没有建库权限,报 P3014)
- **`pnpm db migrate` / `pnpm db reset` 只许在开发 schema 上执行**(判断见 `scripts/db.mjs` 的 `isDisposableSchema`),
  测试 / 生产只用 `pnpm db deploy`。**AI 执行 reset 会被 Prisma 7 自身拦下**,必须向人说明后果并取得明确同意,不许绕过
- 错误码在各域 `*.errors.ts` 用 `as const` 登记,**是对外契约的一部分**

### 契约包

- 请求 schema 在 `contracts` 前后端共用,导出类型**一律 `z.input`**
- 请求体 `z.strictObject`;响应侧只用 TS 类型,由 `wire.ts` 标注返回类型让编译器保证形状
- **表单 schema 与请求体 schema 是两回事**:表单单独定义 `XxxFormSchema` +
  `handleSubmit` 传第二参 `onFormInvalid`。拿 strictObject 当 resolver 会「点保存没反应」

### 权限

- 权限码真源在 `packages/contracts/src/permissions.ts` 的 `as const`,**不建 Permission 表**
- 受保护路由**必须挂 `secured` 子 app**;每个路由**逐个挂 `requirePermission`**,
  有意不需要权限的登记进 `app.ts` 的 `AUTHENTICATED_ONLY_PATHS`
- 主体显式传参 `service.method(input, actor)`,**不用 AsyncLocalStorage**
- **行级权限:列表和单条(get/update/delete 及一切按 id 的写)都要做**。只做列表是经典漏洞。
  列表传 `scopeOwnerOf(actor)` 当普通查询字段,单条用 `isInDataScope(row.createdBy, actor)`;
  **越界抛 404 不抛 403**(403 等于承认这条存在)。照抄 `user.service.ts`
- 前端 `<Can>` 只控显隐,**不是安全边界**

### 安全

- `hash`/`verify` 只在登录、改密、建号三条路径,**禁止进循环**(单次 64MiB)
- **登录态用 JWT + `Authorization` 头,不用 Cookie**:没有 CSRF、不受 Secure/SameSite 管辖。
  **不要为了"顺手"加回 Cookie**(e2e 有反向断言守着)
- **三条固有代价不是 bug**:改权限要等令牌过期、登出与禁用踢不掉已发的令牌、
  localStorage 被 XSS 可读。详见 `server/src/modules/identity/domain/token-signer.ts`
- JWT 手写 HS256,两处**绝不能动**:校验 `alg` 头(防 `alg:none`)、`timingSafeEqual` 比签名。
  `hs256-token-signer.test.ts` 有 10 条攻击面用例守着
- `JWT_SECRET` 生产必须设(不设拒绝启动)。换掉它 = 强制全员下线,唯一的全局吊销手段
- 用户不存在与密码错误必须**同码、同文案、相近耗时**
- 登录密码明文提交,**传输安全靠 HTTPS**。前端 RSA 加密已移除(理由见 `packages/contracts/src/auth.ts`),需要过等保时从 git 历史恢复
- **连接串绝不整条进日志**(带密码),用 `describeConnection()`

### 配置与路径

- **禁止裸读 `process.env`**,一律从 `src/platform/config/index.ts` 取
- 路径**不要用 `import.meta.url` 数层级**(源码与 dist 层数不同,只炸生产),用 `config.REPO_ROOT`
- **contextPath 默认空**,留给"一台 nginx 按路径反代多个应用"。前端**禁止硬编码前缀**,
  用 `import.meta.env.BASE_URL`;后端用 `config.contextPrefix / contextBase / apiPrefix`
- 启动时**列出所有网卡地址**,不要只打 `127.0.0.1`

### 日志

- **所有写操作至少打一行**,带 `traceId` 与 `actorId`
- stdout + `logs/app-*.jsonl` 两路,按天轮转保留 14 个。**容器部署把 `LOG_FILE` 置空**
- 查日志 `pnpm logs`:`--trace` / `--status 5xx` / `--slow 500` / `--actor` / `--json`
- **脱敏走 `logger/redact.ts` 的递归实现**,不用 pino 内置 `redact`(路径匹配会漏深层键)
- 优雅关闭**必须 `await ctx.closeLogger()`**,否则崩溃前最后几条日志会丢

### 测试

- 单测直接连**真实 PostgreSQL**,**不用 `vi.mock`**。跑测试前在 `.env` 配好 `DATABASE_URL`(测试在里面建 `tmp_` 开头的临时 schema,不碰你的 `_dev` schema)
- 隔离靠**每个测试文件一个临时 schema**:`setupTestDb()` 在开发库里建 schema 并重放迁移 SQL,
  用完 `DROP SCHEMA ... CASCADE`。不需要 CREATEDB 权限,沙箱的共享 PG 上同样成立。
  globalSetup 每次用真实 `prisma migrate deploy` 往探针 schema 跑一遍,守住上线路径
- 命名 `should_<行为>_when_<前置>`;断错误只断 `code` 不断 message
- 照抄:`role.service.test.ts`(最快的标准形状)/ `user.service.test.ts`(多事务与哈希)/
  `user.routes.test.ts`(HTTP 层)/ `lib/actor.test.ts`(纯函数)
- **`app.test.ts` 的两条遍历用例是全站护栏**:匿名断言全 401(守忘挂 `authenticate`)、
  零权限账号断言全 403(守忘挂 `requirePermission`)。改动后**必须做注入探针**
- **`main.ts` 的组装没有测试覆盖**(测的是 `buildApp` 的内层 app),已知盲区

## 四、怎么开发

```bash
pnpm install && cp .env.example .env  # 然后填 DATABASE_URL / DATABASE_SCHEMA
pnpm db up                          # [可选] 本机没有 PG 时用 docker 起一个,沙箱里不可用
pnpm dev                            # 起后端 + 前端(不会自动拉起数据库)
pnpm db deploy && pnpm db seed      # 首次建表灌数据。账号 admin / admin12345
```

| 命令 | 说明 |
|---|---|
| `pnpm dev` / `kill` | 起后端 + 前端 / 清端口 |
| `pnpm db <子命令>` | 数据库唯一入口:`up` / `down` / `deploy` / `seed` / `migrate` / `reset` / `status` / `studio` / `generate` |
| `pnpm logs` | 查 JSONL 日志 |
| `pnpm typecheck` / `lint` / `test` / `test:e2e` | 检查与测试 |
| `pnpm verify` | **提交前跑这个** |
| `pnpm build` / `start` | 打包 / 跑生产产物 |

**`build` 只打包不做类型检查**(96 秒 -> 6 秒),类型错误只有 `typecheck` 会报。
只验一处:`pnpm --filter @app/server exec vitest run <文件>`。
**测试的探针 schema 每次真跑 migrate deploy,不要加缓存** —— 那几秒买的是「迁移文件每次真实执行一遍」。

## 五、加一个业务模块

照抄 user/role,完整步骤见 **`docs/add-module.md`**(九个文件 + 七处接线 + 完工门禁)。

动手前先问清五件事:实体单数名与中文名 / 字段清单(类型、必填、唯一、可空)/
枚举值域与中文标签 / 要不要行级数据权限 / 权限码粒度。
**一个文件建完就跑一次 `pnpm typecheck`**,绿了再建下一个。

## 六、部署

生产是 **nginx 作为唯一入口**的四服务,对外只开一个端口。

```
nginx(7101) ──┬── /       前端静态资源(gzip + 缓存头 + SPA fallback)
              └── /api/   反代到 app:7101
app       只跑 API,不暴露端口,无状态(可多实例)
migrate   一次性容器: migrate deploy + seed,跑完退出。app 等它成功才启动
postgres  数据库,数据在命名卷里
```

```bash
cd deploy && cp .env.compose.example .env    # 至少填 POSTGRES_PASSWORD 与 JWT_SECRET
docker compose -f docker-compose.prod.yml up -d --build
```

后端**不托管前端静态资源**(`SERVE_WEB` 已删)—— 静态资源、压缩、缓存头全归 nginx。

**三份 compose**:`dev.yml`([可选] 只有 PG,7103,`pnpm db up` 手动起)/ `test.yml`(四服务,7104,**测试环境 =
生产的预演**,拓扑与 prod 一致、`NODE_ENV` 也是 production)/ `prod.yml`(四服务,7101)。

- 三份都显式写顶层 `name:` —— 默认项目名取自目录名,不写会共用 `deploy`,
  对生产栈 `down -v` 会把开发数据库容器一起删掉(踩过)
- 单元测试与 e2e 连的是 `DATABASE_URL` 指向的库,靠临时 schema 隔离,**不要为跑测试单独起 PG 实例**
- 不用 `override.yml`(自动加载,容易带错配置)、不用 profiles(忘带参数就起错东西)
- 生产那份**不叫 `docker-compose.yml`**:默认文件名意味着随手 `docker compose up` 就起生产
- `-f a.yml -f b.yml` 是**合并**语义不是"起两个",同名服务会被合并
- **test 与 prod 的重复是有意的**:测试环境常要临时改东西,独立文件零风险。
  staging 则复用 `prod.yml` + 独立 `.env`(它就是生产,没有临时改的诉求)

## 七、已锁定不做(不要重新评估)

**[判断]** 是工程结论,**[偏好]** 可按项目改。

- **[判断]** 用 JWT 而不是会话查库。"无状态优势为零、做不到强制下线"**技术上仍成立**,
  但真正的代价在 Cookie 带来的部署期问题(Secure、CSRF 白名单、Path 跟随 contextPath),
  表现全是"某某环境登不上"。换 JWT 后一次性消失,代价见第三节「安全」
- **[判断]** 不建 Permission 表 / 不做通配符权限码 / 不做用户直授权限
- **[判断]** 不建菜单表、不做动态路由下发(前端路由是编译期产物,必然漂移)
- **[判断]** 不做 SQL 表达式驱动的动态数据权限 / 不做多租户 / 不引 DI 容器
- **[判断]** 前端密码加密**不用哈希**(哈希会直接变成新口令,还能被重放)
- **[判断]** 不引重组件库(AntD/MUI);业务层不直接 import axios
- **[偏好]** 不做 OAuth/SSO/LDAP/扫码 · MFA/验证码/密码复杂度 · 自助注册/找回密码 ·
  审计日志表 · 状态管理库

## 八、踩过的坑

> 只记「现象 -> 处理」。完整根因在对应文件的头注释里。

**配置与路径** — 生产找不到配置而 dev 正常:`REPO_ROOT` 别数层级,向上找 `pnpm-workspace.yaml` |
启用 contextPath 后页面 404 但 API 通:路由缺 `basepath` |
contextPath 下登录页 401 反复自跳:别用含前缀的 `window.location.pathname`

**HTTP 与契约** — 校验失败的响应形状不一致:`zValidator` 绕过 `onError`,包一层 `validate()` |
请求体过大返回 500 而非 413:`handle-error.ts` 要认 `HTTPException` |
日期框留空被判格式错:空值是 `''`,契约里归一成 null |
表单点保存没反应:别拿 strictObject 当 resolver |
API 的 404 返回纯文本:Hono **子 app 的 notFound 不生效**,root 也要挂

**数据库** — 唯一冲突只返回笼统码:P2002 的字段名**三种 provider 三种形状**
(v6 `meta.target` / SQLite `constraint.fields` / **PG `constraint.index` 是索引名**),三种都读。
只有断言具体错误码的测试才抓得住 | `skipDuplicates` 报错:那是 SQLite 限制,PG 可用

**测试与前端** — Git Bash 的 `/tmp` 与 Node 的 `/tmp` 不是同一个目录,测试脚本别用 |
`getRandomValues` 报类型错:不能从 crypto 解构

**日志与进程** — pino-roll 生成 .log 而非 .jsonl:`extension` 只在文件名不含扩展名时生效 |
Windows 下 Ctrl+C 后端口仍被占:`taskkill /T` 杀整棵树 |
Windows 终端 curl 发中文乱码:用 `--data-binary @文件`。
**同理 `node -e` 里带反引号会被 bash 当命令替换** —— 复杂脚本写成文件再跑

**容器** — 镜像 build 成功但 run 必炸:pnpm workspace 是软链结构,手工 COPY 搬不全,
用 `pnpm deploy --filter --prod --legacy`。**只 build 不 run 发现不了** |
`docker build` 卡在 `prisma generate`:`prisma.config.ts` 别在顶层抛异常(generate 不连库) |
应用正常但 docker 一直 unhealthy:`HEALTHCHECK` 里用了 build ARG,运行时展开为空,
改用 node 读 `process.env.PORT`(k8s 里表现为 pod 反复重启) |
容器起来但没账号可登录:seed 走 tsx 依赖源码而镜像只有 dist,把 seed 也打包 |
响应出现两条 `Cache-Control`:nginx 的 `expires` 自己会生成一条,只用 `add_header` |
对生产栈 `down -v` 把开发库删了:三份 compose 都要写 `name:` |
优雅关闭不执行、日志丢失:PID 1 是 sh 时信号不转发,启动脚本最后必须 `exec`,
且 Dockerfile 用 `CMD ["./start.sh"]` 数组形式

**[已根治]** 内网 HTTP 登录 200 却紧接 401(Cookie 的 Secure 被静默丢弃)/
登录报"请求来源不被信任"(origin-guard 白名单)/ contextPath 下 js 变成 index.html 内容
—— 前两个随 JWT 改造消失,第三个随"后端不再托管静态资源"消失。

## 九、协作方式

- 改动前先给方案,等确认再写代码;变更最小化影响面
- 注释写「干什么 / 解决什么问题」,记录**为什么不选另一个方案**;不写零信息量的注释
- 迁移 SQL 手动加注释 —— 裸 DDL 对接手的人是天书

**先问再做**:引新依赖(先查第七节)、改 domain 接口、跨层调用、
绕过 Repository 写数据、在 composition 之外做装配。
