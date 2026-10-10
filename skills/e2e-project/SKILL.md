---
name: e2e-project
description: 按用户意图对基于 aibase 模板的项目做浏览器端到端验证。AI 用 playwright-cli 打开页面、读快照理解 DOM、操作、截图,每一步留证据(steps.jsonl + 截图 + 快照 + trace),生成 HTML 报告给用户验收;用户确认后归档到 e2e/archive/,并把操作沉淀为 @playwright/test 回归脚本(e2e/ui/*.spec.ts)。当用户说「e2e」「端到端测试」「验收一下这个功能」「点一遍看看」「回归测试」时使用。
---

# e2e-project:端到端验证与验收

e2e 依赖**用户的意图**和**AI 的理解**,所以一次验证分 8 步:开头确认理解对不对,结尾由用户判定通不通过。
AI 不直接调 playwright-cli,一律通过 `scripts/e2e.mjs` 调用,由它保证每一步的证据字段齐全。

```bash
E2E="node ${CLAUDE_SKILL_DIR}/scripts/e2e.mjs"
```

**开始前**:读一遍 `LESSONS.md`。

---

## 推荐版本(建议,非强制)

| 包 | 推荐版本 |
|---|---|
| `@playwright/cli` | `0.1.22` |
| `@playwright/test` | `1.64.0-alpha-1790635538000`(= playwright-cli 0.1.22 依赖的内核) |

- 这一对与沙箱镜像 `ts-nodejs-aibase-sandbox` 预装的 chromium 1247 对应(镜像用环境变量 `PLAYWRIGHT_CORE_VERSION` 声明),
  用它们就直接使用预装浏览器,不需要下载;aibase 模板默认就是这一对。
- 项目若因故用了别的版本,也能用,只是要现场下载浏览器;doctor 会给出 `[WARN]` 提示,不拦截。
- 两个包始终保持同一内核:选 playwright-cli 版本后,用 `npm view @playwright/cli@<版本> dependencies` 查它的
  `playwright-core`,`@playwright/test` 锁到同一个版本号。
- **不要用 `npx playwright ...`**:npx 拉最新正式版,内核不同,会去下载另一个版本的浏览器。

## 第 1 步 环境检查

```bash
$E2E doctor --project-dir <项目目录> --base-url <被测地址>
```

| 检查 | 不通过时 |
|---|---|
| 项目里有 playwright-cli 与 `@playwright/test`(都是 `e2e/package.json` 的开发依赖,版本由 lockfile 锁定) | 失败:先 `pnpm install` |
| 两者的内核(playwright-core)版本相同 | 失败:按 `e2e/README.md` 的升级规则改 `e2e/package.json` |
| 沙箱有没有内置 playwright-cli;有的话版本、内核与项目是否一致 | 不一致时 `NEED_CONFIRM cli-version`:问用户用哪一份 |
| 内核要求的那个版本的 chromium 已安装(按准确版本判断) | `NEED_CONFIRM install` |
| Linux 上有中文字体 | `NEED_CONFIRM install`(缺字体时页面文字是空白方块,浏览器处理输入还可能崩溃) |
| 被测地址首页能打开,`/api/health` 返回 ok | 失败:先 `pnpm dev`,或查端口占用 |

| NEED_CONFIRM | 用户同意后 |
|---|---|
| `cli-version` | `--use-cli project`(推荐:与回归测试同一内核)或 `--use-cli sandbox`;`start` 也要带同一个参数,整次运行不换 |
| `install` | 加 `--install` 重跑。国内下载慢,征得用户同意后加环境变量 `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright` |

- **绝不用软链把别的版本的浏览器冒充成所需版本**:内核与浏览器版本错配时,导航和快照正常,点击、输入却静默失效
- 字体装在用户目录 `~/.local/share/fonts/`,不需要 root;脚本会生成 fontconfig 配置并自动让浏览器使用
- Linux 启动浏览器报缺少系统库时,需要有 root 的人执行 `pnpm --filter @app/e2e exec playwright install-deps chromium`

## 第 2 步 收集信息并确认理解

询问用户,一次问完:

| 信息 | 说明 |
|---|---|
| 测什么 | 用户原话,记为 `intent` |
| 被测地址 | 本机 `http://localhost:<WEB_PORT>`(先 `pnpm dev`);或已部署环境,地址见 deploy-project 的 `deployments.json` |
| 账号 | 默认 admin;密码从环境变量取,本机 `.env` 的 `SEED_ADMIN_PASSWORD` 会自动加载;已部署环境的密码让用户先 `export` 到环境变量 |

然后把理解写成 `plan.json`(放在 skill 的 `tmp/` 下),**拿给用户确认后**再开始:

```json
{
  "intent": "用户原话",
  "scenarios": [
    { "id": "S1", "title": "管理员登录", "expect": ["登录后进入用户列表页", "右上角显示 admin"] },
    { "id": "S2", "title": "错误密码登录", "expect": ["停留在登录页", "提示用户名或密码错误"] }
  ]
}
```

每个场景至少一条可观察的期望(页面上看得见、或接口/控制台能验证的)。

## 第 3 步 开始运行

```bash
$E2E start --project-dir <项目目录> --base-url <被测地址> --name <英文短名> --plan <plan.json> [--headed] [--use-cli project|sandbox]
```

`--name` 用小写字母、数字、连字符,同时是回归脚本的文件名。最后一行 `RUN_DIR=...` 是运行目录,后面每条命令都要带。
`--headed` 会弹出浏览器窗口,用户想看着跑时加上。

## 第 4 步 探索与操作

```bash
$E2E act --run <RUN_DIR> --scenario S1 --why "填用户名" -- fill e12 admin
$E2E act --run <RUN_DIR> --scenario S1 --why "填密码" -- fill e15 {{SEED_ADMIN_PASSWORD}}
$E2E act --run <RUN_DIR> --scenario S1 --why "提交登录" -- click e16
```

- `--` 后面就是 playwright-cli 的命令(`goto` / `click` / `fill` / `select` / `press` 等,见 `playwright-cli --help`)
- 每步结束会自动截图、保存快照、记录新增的控制台错误和失败请求,并打印**快照文件路径**
- **元素 ref(e12 这类)从最新的快照文件里找**,每次操作后页面变了 ref 就会变,不要沿用旧的
- 密码等敏感值一律写 `{{环境变量名}}`,不要写明文;记录、快照、回归脚本里只会出现变量名
- `--why` 写这一步要干什么,会出现在报告里

## 第 5 步 判定期望

每条期望都要有一次检查,依据是快照、截图、控制台错误、失败请求:

```bash
$E2E check --run <RUN_DIR> --scenario S1 --expect "登录后进入用户列表页" \
  --actual "地址变为 /users,表格显示 1 条记录" --result pass \
  --assert "await expect(page).toHaveURL(/\/users/);"
```

- `--actual` 写**看到了什么**,不写结论
- `--assert` 写对应的 Playwright 断言,会直接进回归脚本;优先 `getByRole` / `getByText` / `toHaveURL`
- 不符合就如实 `--result fail`,不要为了通过去改期望

## 第 6 步 结束、出报告、跑回归

```bash
$E2E finish --run <RUN_DIR>
```

生成 `report.html` 和回归脚本草稿 `regression.spec.ts`(按顺序拼好的操作代码 + 断言)。
把草稿整理后放到 `e2e/ui/<name>.spec.ts`:补上 `TODO` 断言、去掉探索时的多余步骤、确认密码都是 `process.env[...]`。然后:

```bash
$E2E regress --run <RUN_DIR> --spec e2e/ui/<name>.spec.ts
```

回归结果会写进报告。失败就修脚本(不是改期望)直到通过;确实修不好,在报告里如实保留失败。

## 第 7 步 用户验收

把报告给用户:Windows 上 `start <RUN_DIR>/report.html` 打开,其他环境给出路径。
附一句话总结:几个场景、检查通过 / 失败数、发现的问题(控制台错误、失败请求、不符合期望的地方)。

然后**询问用户是否通过**,以及备注。结论必须来自用户本人,不能替用户判定。

## 第 8 步 归档

```bash
$E2E verdict --run <RUN_DIR> --result pass|fail --note "用户的备注"
```

把运行目录(报告、steps.jsonl、截图、快照、回归脚本草稿,不含 trace 原始文件)复制到 `e2e/archive/<运行号>/`,
并在 `e2e/archive/index.jsonl` 追加一条。查看历史:`$E2E list --project-dir <项目目录>`。

| 用户结论 | 处理 |
|---|---|
| 通过 | 保留 `e2e/ui/<name>.spec.ts`,以后 `pnpm test:ui` 回归 |
| 不通过 | 问用户:是功能有问题(去修代码,修完重新跑一遍)还是测试理解错了(改 plan 重跑)。`e2e/ui/<name>.spec.ts` 是否保留也问用户 |

归档和回归脚本都入库,提交与否听用户的。

---

## 产物

```
e2e/.runs/<运行号>/        过程证据(不入库)
  plan.json  meta.json  steps.jsonl  report.html  regression.spec.ts  regression.json  verdict.json
  shots/  snapshots/  .playwright-cli/(trace 等原始文件)
e2e/archive/<运行号>/      用户验收后的归档(入库)
e2e/archive/index.jsonl    验收记录,每次一行
e2e/ui/<name>.spec.ts      回归脚本(入库),pnpm test:ui 运行
```

`steps.jsonl` 每行一步:`run seq ts scenario kind(act|check) why command code replay result error url title screenshot snapshot newConsoleErrors newFailedRequests`,
检查步骤另有 `expect actual assert`。`meta.json` 记录被测地址、git 提交 / 分支 / 是否有未提交改动、执行人、工具版本。

## 失败处理与积累经验

- 先看 `[FAIL]` 后面的原因;ref 找不到多半是页面变了,重新看最新快照
- 允许在本 skill 的 `tmp/` 目录写临时脚本处理现场问题,密码只走环境变量
- 问题解决后在 `LESSONS.md` 追加一条:**现象 -> 原因 -> 处理**

## 绝不做

- 不在命令、记录、脚本、回复里写明文密码
- 不替用户判定验收结论
- 不为了让检查通过而修改期望或断言
- 不在生产环境做写操作(新增、修改、删除数据),除非用户明确同意
