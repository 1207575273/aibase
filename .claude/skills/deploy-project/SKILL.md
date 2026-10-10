---
name: deploy-project
description: 把基于 aibase 模板的项目部署到测试或生产机器。通过 SSH(账号密码)探测机器的系统、CPU、内存、docker、node、pm2、nginx 与端口占用,询问部署方式(pm2 后端 + nginx 前端,或 docker 前后端一体),打带 git 信息的发布包,上传到版本化目录,检查并执行数据库迁移,健康检查失败自动回滚,最后汇报访问地址。当用户说「部署」「发布到测试 / 生产」「上线」「发到服务器」时使用。
---

# deploy-project:部署项目

一次部署分 8 步。第 1 步由你询问用户;第 2 步单独跑一次探测;第 3~8 步由一条 `deploy` 命令按顺序完成,
中途需要用户拍板时脚本会停下(`NEED_CONFIRM`),你问过用户后带上对应参数重跑,已通过的检查会重新快速走一遍。

**开始前**:读一遍 `LESSONS.md`(已知问题与处理办法)。不需要安装依赖:唯一的依赖 ssh2 已打包在 `scripts/vendor/ssh2.cjs`。

---

## 第 1 步 收集信息

询问用户,一次问完:

| 信息 | 参数 | 说明 |
|---|---|---|
| 机器 IP | `--host` | |
| SSH 端口 | `--port` | 默认 22 |
| 账号 | `--user` | |
| 密码 | 环境变量 `DEPLOY_PASSWORD` | **只放环境变量**,不写进命令参数、文件、回复 |
| 部署环境 | `--env` | `test` 或 `prod` |
| 部署方式 | `--mode` | `pm2`:pm2 跑后端 + 系统 nginx 托管前端;`docker`:docker compose 前后端一体 |
| 对外端口 | `--app-port` | 选填。默认 prod 用项目端口段的 01、test 用 04;再次部署沿用上次的 |

项目目录用 `--project-dir`(默认当前目录)。部署方式可以等第 2 步探测完,根据机器情况给用户建议后再定。

## 第 2 步 探测机器(只读)

```bash
DEPLOY_PASSWORD='...' node "${CLAUDE_SKILL_DIR}/scripts/deploy.mjs" probe --host <IP> --port 22 --user <账号>
```

得到:系统与架构、CPU、内存、磁盘、docker 与 compose、node / pnpm / pm2 / nginx、包管理器、sudo 权限、已占用端口。
汇报给用户,并据此建议部署方式(有 docker 优先 docker;没有 docker 但有 node 可选 pm2)。

首次连接会停下要求核对主机指纹(`NEED_CONFIRM host-key`)。

## 第 3~8 步 执行部署

```bash
DEPLOY_PASSWORD='...' node "${CLAUDE_SKILL_DIR}/scripts/deploy.mjs" deploy \
  --project-dir <项目目录> --env <test|prod> --mode <pm2|docker> --host <IP> --port 22 --user <账号>
```

### 第 3 步 环境检查

| 检查 | 不通过时 |
|---|---|
| 工作区没有未提交改动 | 失败:先提交 |
| **prod 只能部署 main 分支**(test 不限制) | 失败 |
| 项目里有 `deploy/.env.<环境>`,含 `DATABASE_URL`、`DATABASE_SCHEMA`、`SEED_ADMIN_PASSWORD` | `NEED_CONFIRM env-file`:向用户要连接串 / 管理员初始密码写进去 |
| schema 后缀与环境一致(`_test` / `_prod`) | 失败 |
| 目标机有所选方式需要的软件(docker 方式:docker、compose v2;pm2 方式:node ≥ 22.12、pm2、nginx) | `NEED_CONFIRM install`:问用户是否同意安装 |
| 要装软件且 apt 源是国外官方源 | `NEED_CONFIRM mirror`:问用户是否换国内镜像(可选步骤,会先备份原文件) |
| 需要 sudo 时有没有权限(装软件、写 nginx 配置、无 docker 组时操作 docker) | `NEED_CONFIRM no-sudo`:问用户怎么处理 |
| 端口没有被别的程序占用(被本项目上一版占着不算冲突) | 失败,并给出可用端口 |

### 第 4 步 打包

在项目里执行 `pnpm package`,产出 `release/<项目>-<时间>-<提交号>-<方式>.tar.gz`,包里的 `release.json`
记录提交号、分支、提交说明、构建时间、构建人、构建平台、迁移清单。
pm2 方式:构建机与目标机平台一致时依赖随包上传,不一致时到目标机安装。docker 方式:打包源码,在目标机构建镜像。

### 第 5 步 上传与准备(新版本还没生效)

上传到 `<基础目录>/<项目>/<环境>/releases/<发布号>` 并解包;写 `shared/.env`(数据库连接串以项目里的为准,
JWT 密钥以目标机为准:首次部署生成,之后沿用);pm2 方式按需安装依赖,docker 方式构建镜像。

### 第 6 步 迁移预检与执行

用目标机上的 Prisma 连数据库,列出待执行的迁移,扫描删除类语句(DROP / TRUNCATE / DELETE 等)。

| 情况 | 处理 |
|---|---|
| 有删除类语句 | `NEED_CONFIRM migrations`,必须问用户 |
| prod 有任何待执行迁移 | `NEED_CONFIRM migrations`,必须问用户 |
| test 且没有删除类语句 | 直接执行 |

确认后执行迁移;该环境**第一次部署**时同时灌种子数据。**迁移只能向前,不能回滚。**

### 第 7 步 切换、启动与健康检查

把 `current` 指向新版本并启动:pm2 方式 `pm2 startOrReload` + 写 nginx 站点并重载;docker 方式 `docker compose up -d`。
然后在目标机上反复请求 `/api/health`,约 60 秒内不通过就**自动回滚**到上一版本,并打印最近的日志。

### 第 8 步 汇报与登记

照抄脚本最后的汇总告诉用户:**访问地址**、健康检查地址、版本(提交号与分支)、部署方式、目录、执行的迁移。
部署结果记进 `deployments.json`(不含密码),目标机保留最近 5 个版本。查看历史:`node "${CLAUDE_SKILL_DIR}/scripts/deploy.mjs" status`。

---

## NEED_CONFIRM 速查

脚本以退出码 3 结束并打印 `NEED_CONFIRM <类型>` 时,把说明转述给用户,拿到明确答复后带参数重跑。

| 类型 | 出现在 | 用户同意后 |
|---|---|---|
| `host-key` | 第 2 / 3 步 | 加 `--accept-host-key <指纹>` |
| `env-file` | 第 3 步 | 把用户给的值写进 `deploy/.env.<环境>` |
| `install` | 第 3 步 | 加 `--install` |
| `mirror` | 第 3 步 | 换源加 `--mirror aliyun\|tuna\|ustc`;不换加 `--keep-mirror` |
| `no-sudo` | 第 3 步 | 换有 sudo 的账号;pm2 方式也可加 `--skip-nginx` 只部署后端 |
| `migrations` | 第 6 步 | 加 `--confirm-migrations` |

**确认必须来自用户本人对这件事的明确答复**,不能替用户决定。

## 失败处理与积累经验

- 先读 `[FAIL]` 后面的原因,不要原样重跑。
- 允许在本 skill 的 `tmp/` 目录写临时脚本处理现场问题(装软件失败、镜像源不可达等)。
  临时脚本同样要求:密码只走环境变量,有破坏性的操作先问用户。
- 问题解决后在 `LESSONS.md` 追加一条:**现象 -> 原因 -> 处理**。能固化进脚本的,提出来让用户决定是否改脚本。

## 绝不做

- 不在回复、日志、文件里出现密码
- 不替用户确认安装、sudo 操作、迁移
- prod 不部署 main 以外的分支
- 不删除目标机上不属于本次部署的目录和容器
