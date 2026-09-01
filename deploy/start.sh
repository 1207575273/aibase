#!/bin/sh
#
# 应用容器的启动脚本 —— 只做一件事:把应用进程拉起来,并让它成为 PID 1。
#
# ── 它不做什么 ──────────────────────────────────────────────────
#
# **不跑迁移、不灌种子**。那两件事由独立的一次性容器负责(start-migrate.sh),
# compose 用 `depends_on: condition: service_completed_successfully` 保证它先跑完。
# 理由见 start-migrate.sh 的头注释,简单说是两条:
#   - 多实例部署时每个 app 都跑一遍迁移会并发抢锁
#   - "迁移失败"是部署失败,"应用起不来"是运行故障,两种语义不该混在一个容器里
#
# ── 为什么保留这个文件,而不是直接写 CMD ["node", "server/dist/main.js"] ──
#
# 单看现在这一行,CMD 的 exec 形式确实等价 —— node 同样会是 PID 1。
# 保留它换来的是:
#   1. **一个放启动前逻辑的地方**。等依赖就绪、按环境变量拼参数、打印诊断信息,
#      这类需求迟早会来;塞进 Dockerfile 的 CMD 里就变成没法加注释的一长串。
#   2. **与 start-migrate.sh 对称**。两个容器各有一个入口脚本,
#      "这个容器启动时到底干了什么"永远只需要看一个文件。
#   3. **改启动逻辑不必动 Dockerfile**,也就不会让镜像层缓存整个失效。
#
# ── 唯一一条铁律:最后必须 exec ─────────────────────────────────
#
# `exec` 让 node **顶替**本 shell 成为容器主进程(PID 1),而不是当它的子进程。
#
# 不 exec 的话 PID 1 是 sh,而 `sh` 收到 SIGTERM **不会转发给子进程**:
# docker stop 发的信号停在 shell,node 完全收不到,10 秒后被 SIGKILL 强杀。
# 后果很具体 —— bootstrap/shutdown.ts 的优雅关闭一行都不执行:
# 在途请求被当场掐断,`await ctx.closeLogger()` 不跑,
# **崩溃前最后几条日志直接丢失**(那几条往往正是崩溃原因)。
#
# 同理,Dockerfile 里也必须用 `CMD ["./start.sh"]` 这种 exec 形式(JSON 数组)。
# 写成 `CMD ./start.sh` 会被 docker 包一层 `/bin/sh -c`,PID 1 又变回那个 sh,
# 这里的 exec 就白写了。
#
# node 当 PID 1 是安全的: 内核对 PID 1 忽略的是信号的**默认动作**,
# 而 shutdown.ts 里显式 process.on('SIGTERM') 注册过处理器,照常触发。
#
# ── set -eu ─────────────────────────────────────────────────────
#
# -e 任一命令失败立即退出(现在只有一条命令,但将来加了启动前检查就靠它兜底)
# -u 引用未定义变量直接报错,而不是当成空串继续跑 —— 环境变量拼错时能立刻发现
set -eu

echo "[start] 启动应用..."

# ★ exec 不能删。理由见文件头。
exec node server/dist/main.js
