# Keel

基于 Node.js 通用业务模板初始化。轻量 DDD 四层 + 认证鉴权 + 权限管理已就位。

**技术栈**:Node 22 + Hono + Prisma 7 + PostgreSQL | React 19 + Vite + TanStack + Tailwind v4 + shadcn/ui

## 快速开始

```bash
pnpm install && cp .env.example .env   # 然后填 DATABASE_URL / DATABASE_SCHEMA
pnpm dev            # 起后端 + 前端(不会自动拉起数据库)
```

首次跑要先建表灌数据:

```bash
pnpm db deploy && pnpm db seed
```

- 前端 http://localhost:7102/
- 后端 http://localhost:7101/api/health
- 账号 `admin` / `admin12345` —— **上线前必须改**

**端口连号好记**:7101 生产入口(开发态是后端,同一个号)、7102 前端 dev、7103 本机可选开发库、7104 测试环境入口。

数据库由你在 `.env` 里配置(开发 / 测试 / 生产各一套,schema 按后缀 `<项目>_dev` / `_test` / `_prod` 区分)。
本机没有 PG 时可以用 docker 临时起一个(沙箱里不可用):

```bash
pnpm db up      # 起开发库(7103)
pnpm db down    # 停
```

## 目录

```
server/      后端(modules/<模块> 内分 domain / application / infra / interfaces 四层)
web/         前端
e2e/         端到端测试
packages/    共享包(contracts:前后端共享契约)
deploy/      Dockerfile / compose / nginx 配置
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` / `pnpm kill` | 起后端 + 前端 / 清端口 |
| `pnpm logs` | 查 JSONL 日志(`--trace` / `--status 5xx` / `--slow 500`) |
| `pnpm db <up / down / deploy / seed / migrate / reset / status / studio>` | 数据库操作的唯一入口,见 `scripts/db.mjs` 头注 |
| `pnpm typecheck` / `lint` / `test` / `test:e2e` | 检查与测试 |
| `pnpm verify` | **提交前跑这个** |
| `pnpm build` / `pnpm start` | 打包 / 跑生产产物 |

跑测试前数据库要在跑(`pnpm dev` 起过就行)。测试之间用**独立 database** 隔离,
互不干扰,可以并行。

## 加业务模块

**先读根目录 `CLAUDE.md`** —— 分层、HTTP、分页、权限、日志的硬约束都在里面,
第五节有加模块的完整步骤。

## 部署

生产是 **nginx 作为唯一入口**的四服务编排,对外只开一个端口:

```
nginx(7101) ──┬── /       前端静态资源(gzip + 缓存头 + SPA fallback)
              └── /api/   反代到 app
app       只跑 API,不暴露端口,无状态
migrate   一次性容器:迁移 + 种子,跑完退出;app 等它成功才启动
postgres  数据库,数据在命名卷里
```

```bash
cd deploy
cp .env.compose.example .env    # 至少填 POSTGRES_PASSWORD 和 JWT_SECRET
docker compose -f docker-compose.prod.yml up -d --build
```

对外端口默认 7101,与开发态后端一致 —— 不用记两个号。改端口设 `APP_PORT`。
