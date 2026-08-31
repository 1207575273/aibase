# Keel

基于 Node.js 通用业务模板初始化。轻量 DDD 四层 + 认证鉴权 + 权限管理已就位。

**技术栈**:Node 22 + Hono + Prisma 7 + SQLite | React 19 + Vite + TanStack + Tailwind v4 + shadcn/ui

## 快速开始

```bash
pnpm install
pnpm db:deploy && pnpm db:seed
pnpm dev
```

- 前端 http://localhost:7102/
- 后端 http://localhost:7101/api/health
- 账号 `admin` / `admin12345` —— **上线前必须改**

## 目录

```
server/      后端(domain / application / infrastructure / interface 四层)
web/         前端
e2e/         端到端测试
contracts/  前后端共享契约
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` / `pnpm kill` | 起全栈 / 清端口 |
| `pnpm logs` | 查 JSONL 日志(`--trace` / `--status 5xx` / `--slow 500`) |
| `pnpm db:migrate` / `db:seed` / `db:reset` | 迁移 / 种子 / 重建 |
| `pnpm typecheck` / `lint` / `test` / `test:e2e` | 检查与测试 |
| `pnpm test:all` | **提交前跑这个** |
| `pnpm build` / `pnpm start` | 打包 / 跑生产产物 |

## 加业务模块

**先读根目录 `CLAUDE.md`** —— 分层、HTTP、分页、权限、日志的硬约束都在里面,
第四节有加模块的完整步骤。

## 部署

生产是单进程单端口(后端托管前端静态资源):

```bash
pnpm build
SERVE_WEB=web/dist NODE_ENV=production pnpm start
```

或 `docker compose up`。
