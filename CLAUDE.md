# 项目开发指令

> 每次会话自动加载。**只写约束与结论**,展开的理由都在对应代码文件的头注释里 ——
> 要改某条约束,先去读那个文件的注释。通用编码偏好见 `~/.claude/CLAUDE.md`。
>
> 加业务模块直接说需求即可,步骤见第四节末尾。

## 一、项目是什么

Node.js 通用业务模板。认证鉴权、分页、审计、事务、错误处理都已就位,
自带**人员管理 CRUD** 作为标准示范,任何业务照着它长。

```
server/      后端(轻量 DDD 四层)     web/    前端 SPA
e2e/         端到端(起真进程)         contracts/  前后端共享契约
scripts/          开发脚本
```

## 二、技术栈

版本**精确锁定**(无 `^` `~`),升级走单独 commit。下面几条是**被别的依赖锁死的**,升级前先看:

| 依赖 | 版本 | 锁定原因 |
|---|---|---|
| better-sqlite3 | 12.11.1 | Prisma adapter 的 peer 是 `^12.6`,**不能升 13** |
| typescript | 6.0.3 | `@typescript-eslint/parser` peer 上限 `<6.1`,**不能升 7** |
| prisma / @prisma/client / adapter | 7.10.0 | **npm 上 `prisma` 的 `latest` 标签已经指向 `8.0.0-rc`**,而 `@prisma/client` 的 `latest` 仍是 7.10.0 —— 详见下方 |
| @tanstack/router-plugin | 1.168.35 | 它自己就发到这个版本,落后于 react-router 是正常的 |

**Prisma 千万别用 `@latest` 装**。`prisma` CLI 包的 npm `latest` 已经是 8.0.0-rc,
`@prisma/client` 的 `latest` 还是 7.10.0,两者不匹配。实测 `pnpm add -Dw prisma@latest`
的后果:CLI 装成 8.0.0-rc.12,`postinstall` 的 `prisma generate` 直接报
`No command registered for 'generate'`(8 的 CLI 连命令都重构了),安装以退出码 2 失败。
好在它炸得很响不会静默中招,`pnpm install --frozen-lockfile` 可完全还原。
7.10.0 已经是 client 与 adapter 的最新**稳定版**,不是落后版本。

升级要三个包同版本一起动(`prisma` / `@prisma/client` / `@prisma/adapter-better-sqlite3`),
走单独 commit。Prisma 8 是 TypeScript 完全重写的新基座,不是 7.x 的增量升级;
它 2026-03 宣布,至今仍是 rc,路线图上先做 Postgres GA ——
**SQLite 何时在 8 里 GA 没有时间点,这是本项目最该盯的一条**。

其余:Node ≥22.12、hono 4.13.5、zod 4.4.3、vitest 4.1.11、esbuild 0.28.2、
pino 10.3.1 + pino-roll 4.0.0 | React 19.2.8、vite 8.2.2、TanStack Router/Query、
Tailwind v4、radix-ui(shadcn 底座)、react-hook-form、axios。

**安全相关零第三方依赖**:密码哈希 `node:crypto` scrypt,token randomBytes+sha256,
登录加密 Web Crypto RSA-OAEP+AES-GCM。
**shadcn/ui 不当 npm 包用** —— `pnpm dlx shadcn@latest add <组件>` 生成源码到仓库。

## 三、硬约束(绝不破)

### 分层

`interface -> application -> domain`,infrastructure 实现 domain 定义的接口。
domain 只放类型 + 接口 + 纯函数,零 IO;业务逻辑在 application。

六条边界由 eslint 守着(`eslint.config.mjs`):R1 domain 不依赖外层 / R1b application
不依赖 infrastructure / R2 跨域只走对方 domain / R3 只有 interface 能 import 契约 /
R4 禁裸读 `process.env` / R5 前端业务层禁 import axios。

**加规则必须做注入探针**:写一行违规代码确认真报错再删掉。

### 代码组织

- **不搞 CQRS**。读写都走 Repository,不要引入 `*.query.ts` 轨
- **一个聚合一个 Service**。方法超 ~80 行 / 需要独占依赖 / 跨聚合事务 —— 满足任一才拆
  成 `<动作>.usecase.ts` 由 Service 委托
- 装配在 `composition/modules.ts`,**加业务不改 main.ts**

### HTTP

- **只用 GET / POST**。读一律 GET+query(不要因为参数多改成 POST),
  写一律 POST 且**动词写在 URL 里**:`POST /users/:id/update`
- **固定路径必须注册在 `/:id` 之前**
- **任何列表端点都必须分页**(`PageQuerySchema`,默认 20 上限 100),
  Repository 里不允许有返回全量数组的方法
- 请求校验一律用 `interface/http/validator.ts` 的 `validate()`,
  **不要直接用 `zValidator`**(它有自己的错误格式,会绕过统一出口)
- 路由 handler **不写 try/catch**,全站只有一个 `AppError` + 一个 `app.onError`

### 数据

- **唯一性靠 DB 约束 + P2002 翻译,禁止 check-then-act**("先查后写"并发下必炸)
- 时间**一律由注入的 Clock 产生**,禁止 `@default(now())` / `@updatedAt`,
  也禁止在 Repository 里偷写 `new Date()`;ID 用注入的 IdGenerator(UUID v7)
- 存储 UTC,展示与按日聚合用 Asia/Shanghai,转换只在 wire 层
- 只有"哪一天"语义的字段存 `YYYY-MM-DD` 字符串,不存 DateTime
- 每张业务表必须有 `createdAt/updatedAt/createdBy/updatedBy`,
  业务表 `createdBy` **非空**(它是行级权限的过滤锚点)
- **不用 `deletedAt` 软删**(会污染此后每条查询),状态用业务字段表达
- 错误码在各域 `*.errors.ts` 用 `as const` 登记,**是对外契约的一部分**

### 契约包

- 请求 schema 在 `contracts`,前后端共用;导出类型**一律 `z.input`**
- 请求体一律 `z.strictObject`;响应侧**只用 TS 类型不用 zod**,
  由 `wire.ts` 的 `toXxxWire` 标注返回类型让编译器保证形状
- **表单 schema 与请求体 schema 是两回事** —— 表单持有全部字段,
  拿 strictObject 当 resolver 会导致「点保存没反应且无提示」。
  表单单独定义 `XxxFormSchema`,并给 `handleSubmit` 传第二参 `onFormInvalid`

### 权限

- 权限码真源在 `contracts/src/permissions.ts` 的 `as const`,**不建 Permission 表**。
  加模块 = 加几行常量 + 路由挂 `requirePermission`,零迁移
- 受保护路由**必须挂到 `secured` 子 app**,`app.test.ts` 有回归测试兜底
- 主体显式传参 `service.method(input, actor)`,**不用 AsyncLocalStorage**
- 行级权限:列表**和**单条访问(get/update/delete)**都要**做,只做列表是经典漏洞
- 前端 `<Can>` 只控显隐,**不是安全边界**

### 安全

- `hash`/`verify` 只能出现在登录、改密、建号三条路径,**禁止进循环**(单次占 64MiB)
- **登录态用 JWT + `Authorization` 头,不用 Cookie**。凭证由前端显式携带,
  所以没有 CSRF(无需 origin 白名单)、不受 Secure/SameSite/Path 管辖 ——
  换 IP、换域名、明文 HTTP 都能直接用。**不要为了"顺手"加回 Cookie**,
  那会把这一整类部署期问题带回来(e2e 有反向断言守着)
- **三条固有代价,不是 bug**:改权限要等令牌过期才生效、登出与禁用踢不掉已发出的令牌、
  令牌存 localStorage 被 XSS 可读。要缩短前两条的窗口只能调短 `JWT_TTL_SECONDS`;
  要彻底解决只能换回会话查库。详见 `domain/auth/token-signer.ts` 头注释
- JWT 用 `node:crypto` 手写 HS256(安全相关零第三方依赖)。两处**绝不能动**:
  必须校验 `alg` 头(防 `alg:none` 绕过)、签名必须 `timingSafeEqual` 比较。
  `hs256-token-signer.test.ts` 有 10 条攻击面用例守着
- `JWT_SECRET` 生产必须显式设置(不设直接拒绝启动)。换掉它 = 强制全员下线,
  这也是唯一的全局吊销手段
- 用户不存在与密码错误必须返回**同一个码、同一句文案、相近耗时**
- 密码不以明文进请求体(RSA+AES 混合 + 一次性 nonce)。
  **这不能替代 HTTPS** —— 它解决的是密码进 DevTools / nginx 日志 / APM 抓包,
  以及安全测评对「口令加密传输」的要求。强制加密:`AUTH_REQUIRE_ENCRYPTED_PASSWORD=true`

### 配置与路径

- **禁止裸读 `process.env`**,一律从 `src/config/index.ts` 取
- 端口与 contextPath 在 `.env`(PORT / WEB_PORT / CONTEXT_PATH),后端、vite、开发脚本
  读同一份。**不要再引入独立的端口文件** —— 试过 ports.json,读它 5 处、绕过它
  硬编码 6 处,反而制造"改一处就够了"的错觉,实锤漂移两次(容器端口对不上、
  e2e 端口撞开发端口)。临时换端口用 `PORT=8080 pnpm dev`,不改文件
- 路径**不要用 `import.meta.url` 数层级**(源码与 dist 层数不同,会只炸生产),
  也不要赌 cwd —— 用 `config.REPO_ROOT`
- **contextPath 默认空**,一般用不到,留给"一台 nginx 按路径反代多个应用"的场景。
  设成 `/myapp` 后 API 与页面前缀一处生效。
  前端**禁止硬编码路径前缀**,用 `import.meta.env.BASE_URL`;
  后端用 `config.contextPrefix / contextBase / apiPrefix`。
  归一化逻辑有**两份实现**(后端 config 的 TS、`scripts/ports.mjs` 的 JS ——
  两个加载环境无法共享代码),vite 与 e2e 都直接 import 后者。
  `config/ports-default.test.ts` 做行为比对,`context-path.test.ts` 做源码文本比对
- 启动时**列出所有网卡地址**,不要只打 `127.0.0.1` 或 `0.0.0.0`

### 日志

- **所有写操作至少打一行**,带 `traceId` 与 `actorId`
- 两路输出:stdout(开发彩色/生产 JSON)+ `logs/app-YYYY-MM-DD.n.jsonl`(始终 JSONL)。
  按天轮转、保留 14 个、单文件上限 50MB。**容器部署把 `LOG_FILE` 置空**
- 查日志用 `pnpm logs`:`--trace <id>` / `--status 5xx` / `--slow 500` / `--actor <id>` / `--json`
- **脱敏走 `logger/redact.ts` 的递归实现,不用 pino 内置 `redact`**
  (那个是路径匹配,实测漏 `deep.deeper.password`)。加敏感键去 `SENSITIVE_KEYS`
- 优雅关闭**必须 `await ctx.closeLogger()`**,否则崩溃前最后几条日志会丢

### 测试

- 单测直接连**真实临时 SQLite**(模板库+文件复制,毫秒级),**不用 `vi.mock`**
- 命名 `should_<行为>_when_<前置>`;断错误只断 `code` 不断 message
- 一个模块该测什么,照抄 `app.test.ts` 与 `actor.test.ts`

## 四、怎么开发

```bash
pnpm install && cp .env.example .env
pnpm db:deploy && pnpm db:seed        # 账号 admin / admin12345
pnpm dev                              # 后端 7001 + 前端 7002
```

| 命令 | 说明 |
|---|---|
| `pnpm dev` / `pnpm kill` | 起全栈(Ctrl+C 杀进程树) / 清端口 |
| `pnpm logs` | 查 JSONL 日志 |
| `pnpm db:migrate` / `db:seed` / `db:reset` | 迁移 / 种子 / 重建 |
| `pnpm typecheck` / `lint` / `test` / `test:e2e` | 检查与测试 |
| `pnpm test:all` | **提交前跑这个**(typecheck + lint + build + test + e2e) |
| `pnpm build` / `pnpm start` | 打包 / 跑生产产物 |

**`build` 只打包,不做类型检查**(拆开之前是 96 秒,现在 6 秒)。所以类型错误只有
`pnpm typecheck` 会报 —— 别因为 build 过了就以为没问题。改完只想验一处时,
直接指定文件跑:`pnpm --filter @app/server exec vitest run <文件>`。

两处缓存在 `node_modules/.cache/` 下(tsc 增量、eslint),都是各自工具的官方机制,
失效由它们自己管。真要清就 `rm -rf node_modules/.cache`。

**测试的模板库每次重建,不要给它加缓存**。建库那 ~5 秒买的是「迁移文件本身每次都被
真实执行一遍」—— 这正是用 `migrate deploy` 而不是 `db push` 的理由(见
`tests/helpers/global-setup.ts` 头注释)。试过按 migrations 内容 hash 缓存,
为了堵住"升级 prisma 但迁移没变"这类盲区又得把 schema、prisma 版本、
better-sqlite3 版本全塞进指纹 —— 需要这么多补丁才能保证正确的优化,不值这 5 秒。

## 五、加一个业务模块

照抄 user/role。**一个文件建完就跑一次 `pnpm typecheck`**,
绿了再建下一个 —— 九个一起写完再编译,错误堆在一起没法定位。

先问清五件事再动手,字段漏一个就要重跑一次 `db:migrate` 并重写迁移注释:
实体单数名与中文名 / 字段清单(类型、必填、唯一、可空)/ 枚举值域与中文标签 /
要不要行级数据权限 / 权限码粒度(CRUD 四个还是读写两档)。

**九个文件**(`<name>` = camelCase 单数,表名 `biz_` + 单数,路由前缀用复数):

```
contracts/src/<name>.ts                          <=120 行
server/src/domain/<name>/<name>.types.ts             <=75
server/src/domain/<name>/<name>.repository.ts        <=45
server/src/domain/<name>/<name>.errors.ts            <=20
server/src/application/<name>/<name>.service.ts      <=180
server/src/infrastructure/persistence/sqlite/<name>.repository.ts   <=155
server/src/interface/http/<name>.routes.ts           <=95
server/src/application/<name>/<name>.service.test.ts
server/src/interface/http/<name>.routes.test.ts
```

**七处接线,漏一处就编译不过。标 ① ② 的两组必须同轮改完:**

| 位置 | 加什么 |
|---|---|
| `prisma/schema.prisma` | model + 审计四件套 + `@unique` + `@@index`;`db:migrate` 后**手写** migration.sql 注释 |
| `contracts/src/index.ts` | `export * from './<name>.js';` —— 漏了后面全红 |
| ① `domain/shared/unit-of-work.ts` | `RepoBundle` 加仓储接口字段 |
| ① `infrastructure/persistence/sqlite/unit-of-work.ts` | `buildRepos` 加 `<name>: new Prisma<Name>Repository(db),` |
| ② `composition/modules.ts` | new 出 Service 填进返回值(返回类型是 `Omit<AppDeps, ...>`) |
| ② `interface/http/app.ts` | import 路由 + `AppDeps` 加字段 + **`secured.route()`** 挂一行,共三处 |
| `interface/http/wire.ts` | `to<Name>Wire`,**返回类型标注契约类型** |
| `contracts/src/permissions.ts` | 先进 `PERMISSION_GROUPS`,再往 `PERMISSIONS` 加码。零迁移零 seed |

建 Repository **之前**必须先改完 schema 并跑 `db:migrate`,否则 Prisma client 上
没这个 model,几十行 `Property '<name>' does not exist` 是缺 client 不是代码错。
单聚合用不到跨仓储事务时,①可以两行都不加 —— 但不能只加一边。

**前端四个文件**(用户要页面才做),菜单在 `app-shell.tsx` 的 `MENUS` 加一项带 `perm`:

```
web/src/api/<name>.ts                          五个方法,类型全来自契约包
web/src/features/<name>/use-<name>s.ts         queryKey 工厂 + hooks
web/src/features/<name>/<name>-form-dialog.tsx 表单 schema 独立定义
web/src/routes/_app/<name>s.tsx                放 _app/ 下自动受保护
```

**完工门禁**,任一条不过就别说做完了:`pnpm typecheck && pnpm lint && pnpm test`
三绿、占位符清干净、每个端点挂了 `requirePermission`、列表已分页、
**行级权限 list/get/update/delete 四个入口都做了**(只做列表是经典漏洞)、
写操作打了带 `traceId`+`actorId` 的日志、迁移 SQL 补了注释。提交前跑 `pnpm test:all`。

体量基准:一个聚合的 domain+wire+contracts 合计不超过约 120 行,明显超出说明模型太重。

**常见故障**:`Property '<name>' does not exist on type 'PrismaClient'` -> 没跑迁移 |
lint 报 R3 越界 -> domain 里 import 了契约包,枚举在 domain 重写一份 |
`app.test.ts` 变红 -> 路由挂到了 app 根,改挂 `secured` |
点保存没反应且无提示 -> 拿 strictObject 当表单 resolver,单独定义表单 schema + `onFormInvalid` |
新增成功但列表不刷新 -> queryKey 写了字面量,统一走工厂 |
唯一字段重复只返回笼统 409 -> 仓储没把 P2002 翻译成业务码,去 `mapPrismaError` 登记

**部署**:生产单进程单端口(后端托管前端静态资源),
`pnpm build && SERVE_WEB=web/dist NODE_ENV=production pnpm start`,或 `docker compose up`。

## 六、已锁定不做(不要重新评估)

**[判断]** 是工程结论,**[偏好]** 可按项目改。

- **[判断]** 用 JWT 而不是会话查库。原本的判断是"不用 JWT",理由是无状态优势为零
  且做不到强制下线 —— 那个判断在**技术上仍然成立**,但它衡量错了成本:
  真正的代价不在服务端,而在 Cookie 带来的一长串部署期问题
  (Secure 标志、CSRF 白名单、Path 跟随 contextPath),表现全是"某某环境登不上",
  每一个都难定位。改用 JWT + header 后这些一次性消失,代价是明确且可接受的三条
  (见第三节「安全」)
- **[判断]** 不建 Permission 表 / 不做通配符权限码 / 不做用户直授权限
- **[判断]** 不建菜单表、不做动态路由下发(前端路由是编译期产物,必然漂移)
- **[判断]** 不做 SQL 表达式驱动的动态数据权限 / 不做多租户 / 不引 DI 容器
- **[判断]** 前端密码加密**不用哈希**(哈希会直接变成新口令,还能被重放)
- **[判断]** 不引重组件库(AntD/MUI),会锁死风格;业务层不直接 import axios
- **[偏好]** 不做 OAuth/SSO/LDAP/扫码 · MFA/验证码/密码复杂度 · 自助注册/找回密码 ·
  审计日志表 · 状态管理库

## 七、踩过的坑(现象 -> 根因 -> 处理)

1. **生产启动找不到配置文件,dev 却正常** -> `REPO_ROOT` 按源码层级数出来的,
   dist 层级不同 -> 向上找 `pnpm-workspace.yaml`
2. **开发时登录报"请求来源不被信任"** -> 前端 :7002 经 proxy 打到 :7001,
   Origin 与 Host 不同源而白名单为空 -> 非生产环境自动放行 vite dev server
3. **校验失败的响应形状与业务错误不一致** -> `zValidator` 自带错误处理绕过 `onError`
   -> 包一层 `validate()`
4. **请求体过大返回 500 而非 413** -> Hono 的 `bodyLimit` 抛 `HTTPException`
   -> `handle-error.ts` 加分支
5. **邮箱重复返回笼统错误码** -> Prisma 7 的 driver adapter 把字段名从 `meta.target`
   换到 `meta.driverAdapterError.cause.constraint.fields` -> 两种形状都读
6. **日期框留空被判格式错** -> `<input type="date">` 空值提交的是 `''` -> 契约里归一成 null
7. **`skipDuplicates` 报 Unknown argument** -> 那是 PG/MySQL 特性 -> 用 `upsert`
8. **Windows 下 Ctrl+C 后端口仍被占** -> 三层进程信号传不到孙子 -> `taskkill /T` 杀整棵树
9. **Windows 终端 curl 发中文乱码** -> 参数被按 GBK 编码 -> 用 `--data-binary @文件`
10. **启用 contextPath 后 js/css 变成 index.html 的内容** -> Hono 的 `route(prefix)`
    不改写 `c.req.path`,serveStatic 拼错磁盘路径全落 SPA fallback -> 配 `rewriteRequestPath`
11. **启用 contextPath 后一进页面就 404 但 API 通** -> 路由缺 `basepath`
12. **启用 contextPath 后登录页 401 反复自跳** -> 用了含前缀的 `window.location.pathname`
    -> 改用 `router.state.location.pathname`
13. **`crypto.subtle` 是 undefined** -> 只在安全上下文(https/localhost)暴露
    -> `canEncrypt()` 探测后退回明文;要强制加密就上 https
14. **测试断言"密文被篡改应失败"却通过** -> 改 base64 末位可能只动到被丢弃的补位比特
    -> 在字节层面翻转
15. **`getRandomValues` 报 "Value of this must be of type Crypto"** -> 不能从 crypto 解构
16. **pino-roll 生成 .log 而非 .jsonl** -> `extension` 选项只在文件名不含扩展名时生效
    -> 扩展名留在 `file` 里
17. **Git Bash 的 `/tmp` 与 Node 的 `/tmp` 不是同一个目录** -> Node 在 Windows 上解析成
    `C:\tmp` -> 测试脚本别用 `/tmp`
18. **表单「点保存没反应」且无任何提示** -> 拿 strictObject 请求体 schema 当表单 resolver,
    多余字段被判 `unrecognized_keys` 且 path 为根,落不到输入框
    -> 表单单独定义 schema + `onFormInvalid` 兜底
19. **[已根治]** 登录态改用 JWT + header 之后,下面这个坑连同整类 Cookie 问题
    (换 IP 被 origin-guard 拒、Secure 标志静默丢弃)都不再存在。留作记录:
    **内网 HTTP 部署登录 200 却紧接着 401,反复跳登录页** -> Cookie 的 Secure 按
    `NODE_ENV` 判断,而内网生产就是明文 HTTP,浏览器**静默丢弃**带 Secure 的 Cookie
    (不报错不警告,看起来像认证坏了)-> 改按请求实际协议判断(含 `X-Forwarded-Proto`),
    见 `request-proto.ts`

## 八、协作方式

- 改动前先给方案,等确认再写代码;变更最小化影响面
- 注释写「干什么 / 解决什么问题」,记录**为什么不选另一个方案**;
  不写 `// 创建用户` 这种零信息量的
- 迁移 SQL 手动加注释 —— 裸 DDL 对接手的人是天书

**先问再做**:引新依赖(先查第六节)、改 domain 接口、跨层调用、
绕过 Repository 写数据、在 composition 之外做装配。
