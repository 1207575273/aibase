# 多阶段构建 —— 最终镜像只包含运行时需要的东西。
#
# 为什么模板要自带 Dockerfile: 容器化是通用业务系统的默认交付形态,
# 而且它是逼着把「依赖 cwd」「路径写死」这类隐式前提清理干净的最好手段 ——
# 本地跑得好好的项目,容器里第一次启动就会把这些问题全暴露出来。

# ── 阶段 1:装依赖 ──────────────────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app

# better-sqlite3 是原生模块,某些平台没有预编译产物时需要现场编译
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# 只复制依赖清单 —— 业务代码变了不会让这一层缓存失效,重建快很多
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY server/package.json ./server/
COPY web/package.json ./web/
COPY e2e/package.json ./e2e/
COPY contracts/package.json ./contracts/

# 跳过 postinstall(prisma generate)—— 此刻还没有 schema 文件
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── 阶段 2:构建 ────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY . .

# 前后端互不依赖,并行打包。
# [注意] 这里**不做类型检查** —— build 脚本只负责打包(见 package.json)。
# 类型检查是提交前的门禁(`pnpm typecheck`),放进镜像构建只会让每次部署
# 白等十几秒,而且真有类型错误时早在本地就该被拦住了。
RUN pnpm exec prisma generate \
 && pnpm -r --parallel build

# ── 阶段 3:运行时 ──────────────────────────────────────────────
FROM node:22-slim AS runtime

# 端口只在这一处定义,下面的 ENV / EXPOSE / HEALTHCHECK 全部引用它。
# 之前三处各写一遍 7001,而项目端口早已是 7101 —— 容器内跑 7001、compose 映射 7101,
# 起来也连不通,且两边单看都"没写错",极难定位。
# 改端口: docker build --build-arg APP_PORT=8080
ARG APP_PORT=7101
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=${APP_PORT} \
    # 数据库放挂载卷里,容器重建不丢数据
    DATABASE_URL=file:/data/app.db \
    # 后端同时托管前端静态资源,单进程单端口
    SERVE_WEB=web/dist

RUN corepack enable

# 后端产物是 esbuild 打的单文件,但 prisma CLI(跑迁移用)和
# better-sqlite3(原生模块)必须带上
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/src/generated ./server/src/generated
COPY --from=build /app/server/prisma ./server/prisma
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/packages ./packages
COPY package.json pnpm-workspace.yaml prisma.config.ts ports.json ./

# 用非 root 跑。node 镜像自带 node 用户(uid 1000)
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE ${APP_PORT}

# 容器编排会用它判断实例是否可用。/health 是真探活(会 ping 数据库)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:${APP_PORT}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 启动前先应用迁移 —— 保证代码与库结构永远匹配。
# migrate deploy 是幂等的,已应用的迁移会跳过
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node server/dist/main.js"]
