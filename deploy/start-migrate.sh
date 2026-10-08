#!/bin/sh
#
# 一次性初始化容器的入口 —— 迁移 + 种子,跑完就退出。
#
# 与应用容器的分工:
#   start-migrate.sh  改数据库结构,跑一次,退出码决定部署成不成
#   应用容器(Dockerfile 的默认 CMD)  跑应用,长驻,不碰 schema
#
# 为什么要分开(而不是让应用启动时顺手迁移):
#   1. **多实例**下每个应用实例都跑一遍迁移会并发抢锁,而迁移不是幂等到可以并发的
#   2. 迁移失败的语义是"**部署**失败",不是"应用起不来" ——
#      混在一起会让排查方向跑偏:明明是 SQL 写错了,却在查为什么容器一直重启
#   3. 应用容器因此不需要在启动路径上依赖 prisma CLI
#
# compose 里用 `condition: service_completed_successfully` 等它成功退出,
# 所以这个脚本的**退出码就是部署门禁** —— set -e 不能删。
set -eu

echo "[migrate] 应用数据库迁移..."
# migrate deploy 是幂等的: 已应用的迁移会跳过,只补没跑过的。
# 用 deploy 而不是 dev —— dev 会在检测到漂移时尝试重建库,那在生产是灾难。
./node_modules/.bin/prisma migrate deploy --config server/prisma.config.ts

# 种子。全程 upsert,重复执行不会报错,也不会改已存在账号的密码。
# 接管一个已有数据的库、不想让它碰用户表时,设 SKIP_SEED=1。
if [ "${SKIP_SEED:-0}" = "1" ]; then
  echo "[migrate] SKIP_SEED=1,跳过种子"
else
  echo "[migrate] 灌入种子数据(幂等)..."
  node server/dist/seed.js
fi

echo "[migrate] 初始化完成"
