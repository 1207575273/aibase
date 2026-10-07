# 多阶段构建 —— 最终镜像只包含运行时需要的东西。
#
# 为什么模板要自带 Dockerfile: 容器化是通用业务系统的默认交付形态,
# 而且它是逼着把「依赖 cwd」「路径写死」这类隐式前提清理干净的最好手段 ——
# 本地跑得好好的项目,容器里第一次启动就会把这些问题全暴露出来。

# ── 阶段 1:装依赖 ──────────────────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app

# [不需要编译工具链] 这里曾经装着 python3 / make / g++,因为 better-sqlite3 是
# 原生模块,在没有预编译产物的平台上要现场 node-gyp 编译。
# 换成 PostgreSQL 之后驱动是纯 JS 的 `pg`,全部依赖都不需要编译 ——
# 装那三个包白白拖慢每次冷构建、也把镜像层撑大。
# 加依赖时如果又引入了原生模块(会在 pnpm install 阶段报 node-gyp 错),
# 先想想有没有纯 JS 替代,再考虑把工具链加回来。
RUN corepack enable

# 只复制依赖清单 —— 业务代码变了不会让这一层缓存失效,重建快很多
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY server/package.json ./server/
COPY web/package.json ./web/
COPY e2e/package.json ./e2e/
COPY packages/contracts/package.json ./packages/contracts/

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
RUN pnpm exec prisma generate --config server/prisma.config.ts \
 && pnpm -r --parallel build

# 生成**自包含**的部署目录 —— 这是 pnpm 官方为容器部署提供的命令。
#
# 为什么不能直接 COPY node_modules(踩过):
#   pnpm 的 workspace 布局是软链构成的 —— 根 node_modules 里只有根的
#   devDependencies 加一个隐藏的 .pnpm store,运行时依赖都软链在
#   server/node_modules 下,原生模块的 .node 文件还藏在 .pnpm 深处。
#   手工 COPY 这些目录得同时搬对三处相对结构,少一处就是运行期
#   `Cannot find package 'zod'` ——
#   而且**镜像照样 build 成功**,只在 docker run 时才炸。
#   pnpm deploy 直接把依赖从 store 实体化成扁平目录,没有这些坑。
#
# --legacy: pnpm 10 默认要求 workspace 开 inject-workspace-packages,
#   那会改变本地开发时 workspace 包的链接方式(改 contracts 得重新 install 才生效)。
#   为了部署去牺牲开发体验不划算 —— --legacy 只影响这一条命令。
# --prod: 不带 devDependencies。所以 prisma CLI 在 server 的 dependencies 里,
#   容器要自己跑 migrate deploy,它就是这个部署单元的运行时依赖。
RUN pnpm deploy --filter=@app/server --prod --legacy /out

# ── 阶段 3:运行时 ──────────────────────────────────────────────
FROM node:22-slim AS runtime

# 端口只在这一处定义,下面的 ENV / EXPOSE / HEALTHCHECK 全部引用它。
# 之前三处各写一遍 7001,而项目端口早已是 7101 —— 容器内跑 7001、compose 映射 7101,
# 起来也连不通,且两边单看都"没写错",极难定位。
# 改端口: docker build --build-arg APP_PORT=8080
ARG APP_PORT=7101
WORKDIR /app

# [镜像识别标签] 与 compose 里容器的 app.* 标签同一套键。
# 镜像不分环境(test/prod 用同一个镜像正是测试环境的意义),所以只有 project 和 service:
#   docker images --filter label=app.project=keel
# app.title 是中文显示名,给人看(docker inspect / Portainer);
# 过滤永远用 app.project —— 中文值在 GBK 终端里做 --filter 容易因编码错配失灵
LABEL app.project="keel" app.title="Keel" app.service="app"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=${APP_PORT}
#
# [没有 DATABASE_URL 默认值] 连接串由 compose 注入,镜像里不写死 ——
#   给默认值会让"忘了配"变成"连到了某个意外的库",而迁移是破坏性操作。
# [没有 SERVE_WEB] 后端不再托管前端,静态资源归 nginx 容器。
#   数据也不再放容器内的卷: 数据库是独立的 postgres 服务,这个容器无状态。

# [注意] runtime 阶段**不装 pnpm/corepack**。依赖已经是 pnpm deploy 产出的
# 扁平目录,启动脚本直接调 node 与 node_modules/.bin/prisma,不需要包管理器。
# 少装一样东西就少一份攻击面和镜像体积。

# 依赖来自 pnpm deploy 的产物(扁平、自包含、无软链),不是手工拼的 node_modules
COPY --from=build /out/node_modules ./node_modules
# 后端产物是 esbuild 打的单文件: main.js 跑服务,seed.js 灌种子
COPY --from=build /app/server/dist ./server/dist
# Prisma 的生成物与迁移文件 —— migrate deploy 要读 migrations,client 要读 generated
COPY --from=build /app/server/src/generated ./server/src/generated
COPY --from=build /app/server/prisma ./server/prisma
# pnpm-workspace.yaml 不是给 pnpm 用的,是 config/index.ts 定位 REPO_ROOT 的锚点
# (向上找第一个含它的目录),删了会让所有相对路径解析错位
COPY package.json pnpm-workspace.yaml ./
COPY server/prisma.config.ts ./server/prisma.config.ts
COPY deploy/start.sh ./start.sh
COPY deploy/start-migrate.sh ./start-migrate.sh
# 显式加执行位: 构建 context 来自 Windows 时文件权限不可靠,不能赌 COPY 进来的恰好可执行
RUN chmod +x ./start.sh ./start-migrate.sh

# 用非 root 跑。node 镜像自带 node 用户(uid 1000)
RUN chown -R node:node /app
USER node

# [没有 VOLUME] 这个容器是**无状态**的 —— 数据在独立的 postgres 服务里,
# 日志走 stdout 交给 docker 采集。可以随时杀掉重建,也可以水平扩多个实例。
# SQLite 时代这里挂着 /data 存库文件,那也是它没法多实例的根本原因。
EXPOSE ${APP_PORT}

# 容器编排会用它判断实例是否可用。/health 是真探活(会 ping 数据库)。
#
# [坑] 这里**不能用 ${APP_PORT}**。那是 build ARG,只在构建期存在;
# 而 HEALTHCHECK 的 shell 形式 CMD 是在**容器运行时**展开变量的,
# 运行时环境里没有 APP_PORT,于是展开成空串 —— fetch('http://127.0.0.1:/api/health')
# 必然失败。症状极具迷惑性: 应用日志显示"服务已启动"、手工 curl 也通,
# 唯独 docker 一直报 unhealthy。在 k8s 里这会让 pod 被反复重启。
# 改成用 node 直接读 process.env.PORT(那是真正的运行时 ENV)。
#
# contextPath 也要考虑: 设了 CONTEXT_PATH=/myapp 之后 API 挂在 /myapp/api 下,
# 健康检查得跟着走,否则同样是"应用没问题但健康检查永远失败"。
# 这里的归一化逻辑与 config/index.ts 的 normalizeContextPath 保持同一套语义。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const r=process.env.CONTEXT_PATH||'';const c=(r===''||r==='/')?'':(r.startsWith('/')?r:'/'+r).replace(/\/+$/,'');fetch('http://127.0.0.1:'+(process.env.PORT||7101)+c+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 默认入口是 start.sh(只启动应用)。migrate 服务在 compose 里用
# `command: ["./start-migrate.sh"]` 覆盖成迁移+种子那条路 —— 同一个镜像两个入口。
# 两个脚本各自有完整注释。
#
# [关键] 必须用 exec 形式(JSON 数组)。写成 `CMD ./start.sh` 会被 docker
# 包一层 `/bin/sh -c`,PID 1 就成了那个 sh —— 它收到 SIGTERM 不转发给子进程,
# start.sh 里的 exec 也就白写了,优雅关闭仍然不会执行。
CMD ["./start.sh"]
