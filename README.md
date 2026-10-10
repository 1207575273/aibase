# aibase 配套 skill

与 aibase 模板(公司 GitLab `mk-group/v5/saasservice/ts-asset/ts-nodejs-template`)配套的 4 个 Claude Code skill,
覆盖一个项目从创建到上线的 AI 开发闭环:

```
init-project -> model-project -> AI 写代码 -> e2e-project -> deploy-project
```

| skill | 做什么 | 依赖 |
|---|---|---|
| `init-project` | 下载模板归档包,本地 `git init` 独立仓库,改名、分配端口段、写配置、建表、验证 | Node >= 22.12、git、pnpm |
| `model-project` | 用业务语言辅助用户建模,产出建模文件(ER 图 + 表 / 字段 / 关系 / 索引),确认后改 schema 并生成迁移 | 项目本身 |
| `e2e-project` | 按用户意图用 playwright-cli 探索页面,留证据、出报告,用户验收后归档并沉淀回归脚本 | 项目的 e2e 依赖(版本由项目 lockfile 锁定) |
| `deploy-project` | 通过 SSH 部署到测试 / 生产机(pm2 + nginx 或 docker compose),迁移预检、健康检查、失败回滚 | 无(ssh2 已打包在 `scripts/vendor/`) |

4 个 skill 只用 Node 内置模块,**不需要 npm install**。

## 放在哪里

- 本机开发 aibase 本身: 就在 `ts-nodejs-template/.claude/skills/`
- 沙箱 / 其他机器: 放到 `~/.claude/skills/`(init-project 要在项目存在之前运行,所以放全局)

## 约定

- 每个 skill 的结构: `SKILL.md`(流程)、`LESSONS.md`(踩坑记录: 现象 -> 原因 -> 处理)、`scripts/`、`tmp/`(AI 处理现场问题的临时脚本,不入库)
- 运行时登记文件(`projects.json`、`deployments.json`)只在本机,不入库,不含任何密码
- `init-project/config.mjs` 里有模板仓库的**只读**访问令牌(Project Access Token,read_api,只能读模板这一个项目)。
  本仓库若推到远端,只推到公司内部的私有仓库;令牌泄露时到模板项目 Settings -> Access Tokens 撤销并换新
