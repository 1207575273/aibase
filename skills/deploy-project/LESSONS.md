# 部署经验库

每次部署前先读一遍。遇到新问题、在 tmp/ 写临时脚本解决后,按"现象 -> 原因 -> 处理"追加一条。

## 打包

- **Windows 上打包报 `tar: Cannot connect to C: resolve failed`** -> Git Bash 自带的 GNU tar 把 `C:\...` 里的冒号当成远程主机 -> 用系统自带的 `C:/Windows/System32/tar.exe`(bsdtar)。package.mjs 与 deploy.mjs 已按平台自动选择。
- **`pnpm deploy` 导出生产依赖很慢(Windows 上超过 5 分钟),体积约 360MB** -> 主要是 Prisma CLI 与引擎 -> 构建机与目标机平台不一致时本来就不能随包上传依赖;一致时可接受,超时时间要放宽。
- **导出的依赖清单里留着 `"@app/contracts": "workspace:*"`** -> workspace 包已被 esbuild 打进后端产物 -> 运行时清单里去掉 workspace 依赖,否则目标机 npm install 直接报错。package.mjs 已处理。
- **Prisma 执行迁移用的引擎按操作系统区分** -> Windows 上装好的依赖拷到 Linux 不能用 -> 构建平台与目标平台不一致时,依赖到目标机上安装(`--deps target`)。

## 目标机

- **装软件时 `apt-get update` 很慢** -> Ubuntu / Debian 默认源在国外(archive.ubuntu.com 等) -> 征得用户同意后用 `--mirror aliyun|tuna|ustc` 换国内镜像(先备份原文件);选了镜像时 node 改从 npmmirror 下载二进制包,docker 安装脚本走阿里云。dnf / yum 系暂不支持自动换源。
- **探测显示 systemd offline**(容器或精简系统常见) -> systemctl 不可用 -> 服务改用直接启动(如 `nginx`),已在脚本里按 systemdUsable 判断。
- **Ubuntu 的 docker.io 包不含 compose v2** -> docker 方式部署前必须检查 `docker compose version` -> 缺了装 `docker-compose-v2`(或官方源的 `docker-compose-plugin`)。
- **首次连接的端口上可能是别的 SSH 服务**(实测 2222 被其他环境占用) -> 主机指纹确认能拦住 -> 让用户核对指纹,必要时到目标机上用 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 比对。

- **国内直连 npmjs 很慢、经常超时** -> 全局安装与目标机装依赖默认走 `https://registry.npmmirror.com`,可用环境变量 `DEPLOY_NPM_REGISTRY` 覆盖。

## 部署脚本自身

- **服务已经起来了,健康检查却一直失败** -> 远端写成了 `code=$(curl ... || wget ... && echo 200)`,curl 成功时输出 `200200`,永远不等于 200 -> 已改为 `if command -v curl; then ...; else wget ...; fi`。shell 里 `||` 和 `&&` 混用必须拆开写。
- **首次部署后 admin 登录不上** -> 目标机 shared/.env 没有 SEED_ADMIN_PASSWORD,种子随机生成密码且只打印一次,但输出没有转给用户 -> 已改为把初始密码放进最终汇报(失败时也会打印),不写进 deployments.json;种子跑完立即写 .initialized,避免重跑时再灌一次种子。
- **脚本报"已回滚",线上却是 502** -> 切回旧版本后没等它启动完就汇报 -> 已改为回滚后再跑一遍健康检查,按实际结果报 [PASS] 或 [WARN] 需人工介入。
- **docker 方式首次部署,汇报里没有管理员密码,也登录不上** -> compose 的 `${SEED_ADMIN_PASSWORD:-}` 未配置时传空串,种子用 `??` 判断,把空串当成了密码 -> 已改为管理员密码只取 SEED_ADMIN_PASSWORD,没设或空串都报错停下(基座 `server/prisma/seed-password.ts`,有单测);部署前本地检查 `deploy/.env.<环境>` 必须有它,并写入目标机 shared/.env。

## skill 自身

- **skill 搬到沙箱时 node_modules 不好带** -> ssh2 是唯一依赖,且实际只用纯 JS 实现(原生加速模块未编译) -> 已用 esbuild 打包为 `scripts/vendor/ssh2.cjs`,skill 零依赖。升级 ssh2: 在临时目录 `npm install ssh2@<版本>`,再用 `esbuild node_modules/ssh2/lib/index.js --bundle --platform=node --format=cjs --target=node22 --external:cpu-features --external:./crypto/build/Release/sshcrypto.node --outfile=scripts/vendor/ssh2.cjs` 重新生成,并更新文件头的版本号与 ssh2.LICENSE。
