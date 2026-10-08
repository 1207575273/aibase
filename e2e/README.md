# e2e 端到端测试

本目录有两层端到端测试,验证的东西不同,互不替代:

| 层 | 位置 | 工具 | 验证什么 | 谁来写 |
|---|---|---|---|---|
| API 层 | `src/*.e2e.ts` | vitest | 真实服务进程 + 真实 HTTP + 真实数据库下的接口行为 | 开发时手写 |
| 浏览器层 | `ui/*.spec.ts` | @playwright/test | 用户在页面上的完整操作路径 | 由 e2e-project skill 探索后沉淀,用户验收过才入库 |

```bash
pnpm test:e2e     # API 层,包含在 pnpm verify 里
pnpm test:ui      # 浏览器层,被测地址默认 http://localhost:<WEB_PORT>(先 pnpm dev),E2E_BASE_URL 可改
```

本文主要说明浏览器层,API 层的设计见 `src/global-setup.ts` 的头注释。

---

## 一、设计目的

### 要解决的问题

1. **AI 写完功能,"能用"靠什么证明。** 单测和 API e2e 证明的是接口对,证明不了用户在页面上点得通。
   让 AI 自己说"我测过了"不可信,需要**可以复查的证据**。
2. **"对不对"最终是用户说了算。** e2e 依赖用户的意图和 AI 对意图的理解,两者可能有偏差。
   所以一开始要让用户确认 AI 的理解,最后由用户判定通过与否,AI 不能替用户下结论。
3. **验证过一次的东西,以后要能低成本地反复验证。** 每次都让 AI 重新探索既慢又耗 token,结果还不稳定。
   验收通过的操作路径要固化成不依赖 AI 的回归脚本。

### 目标

- 每次验证都产出一份**证据**:每一步做了什么、页面变成什么样(截图 + 快照)、有没有前端报错和失败请求、期望与实际。
- 每次验证都有**用户的验收结论**,并且结论和证据一起**归档入库**,能追溯到当时的代码版本。
- 验收通过的路径变成 `ui/*.spec.ts`,之后 `pnpm test:ui` 回归。

### 不做

- 不追求覆盖率。浏览器层只覆盖用户关心的关键路径,逻辑分支交给单测和 API e2e。
- 不做视觉回归(像素比对)。截图是给人看的证据,不是断言。
- 不在 `pnpm verify` 里跑浏览器层:沙箱里不一定有浏览器,也不一定有可访问的被测环境。

---

## 二、系统原理

### 整体流程

```
用户意图 ──> AI 写 plan.json(场景 + 期望)──> 用户确认理解
                                                │
                                                v
        ┌──────── 探索(AI + playwright-cli,经 e2e.mjs 记录)────────┐
        │  看快照找元素 -> act 操作 -> 自动取证 -> check 判定期望        │
        └─────────────────────────────┬───────────────────────────┘
                                      v
                 finish: report.html + 回归脚本草稿 regression.spec.ts
                                      │
                                      v
                 整理成 ui/<名>.spec.ts -> regress 无头跑一遍,结果写进报告
                                      │
                                      v
                 用户看报告,判定 通过 / 不通过 + 备注
                                      │
                                      v
                 verdict: 归档到 archive/<运行号>/,index.jsonl 追加一条
```

### 三个角色

| 角色 | 职责 | 不做什么 |
|---|---|---|
| **playwright-cli**(pwcli) | 驱动浏览器;每次动作返回等价的 Playwright 代码、页面快照(带元素 ref 的无障碍树) | 不管记录与证据 |
| **e2e.mjs**(skill 脚本) | 包住 pwcli:每一步自动截图、存快照、比对新增的控制台错误与失败请求、脱敏、写 steps.jsonl;生成报告、回归脚本草稿、归档 | 不做判断 |
| **AI** | 理解意图写 plan;读快照决定点哪里;对照期望判定 pass / fail 并写断言 | 不直接调 pwcli;不替用户验收 |

AI 不直接调 pwcli,一律经 `e2e.mjs`,原因是**证据字段由脚本保证齐全**,AI 漏不掉、也改不了。

### 关键机制

**1. 元素定位: 快照里的 ref 只用于探索,脚本里用稳定定位器**

pwcli 的快照把页面表示成无障碍树,每个元素带一个 ref(如 `e12`、`f1e15`),AI 用 ref 操作。
ref 每次页面变化都会重新编号,不能拿来回放。pwcli 每个动作同时给出等价的 Playwright 代码,
这段代码用的是**语义定位器**,例如:

```js
await page.getByRole('textbox', { name: '密码' }).fill('...');
await page.getByRole('button', { name: '登录' }).click();
```

回归脚本就由这些代码按顺序拼成,所以不需要另外维护选择器。

**2. 取证: 每一步之后固定采集**

`act` 或 `check` 之后,脚本等 800ms(给跳转与接口请求留时间),然后采集:
截图 `shots/NNN.png`、快照 `snapshots/NNN.yml`、当前地址与标题、**相对上一步新增的**控制台错误与失败请求(状态码 >= 400)。
新增按顺序增量比对:同一个请求失败两次就记两条。

**3. 脱敏: 密码只以变量名出现**

参数里写 `{{SEED_ADMIN_PASSWORD}}`,脚本从环境变量(及仓库根 `.env`)取真实值去执行,
记录、快照、回归脚本里只出现变量名:回归脚本里是 `process.env['SEED_ADMIN_PASSWORD']!`,其他地方是 `{{SEED_ADMIN_PASSWORD}}`。
脱敏范围是**本次运行用过的所有变量**,因为密码框的值会留在后续步骤的快照里。

**4. 回归脚本: 一个会话串行跑完全部场景**

探索时所有场景共用一个浏览器会话(登录态在场景之间延续),回归脚本也照此生成:
`test.describe.serial` + `beforeAll` 里开一个 page,每个场景一个 `test`。这样脚本的行为和探索时一致,后一个场景可以依赖前一个的状态。

**5. 验收与归档**

`finish` 生成报告,顶部是"待用户验收"。用户给出结论后,`verdict` 写入 `verdict.json` 并重新生成报告(顶部变为通过 / 不通过),
再把运行目录复制到 `archive/<运行号>/`,并往 `archive/index.jsonl` 追加一条。

---

## 三、目录与数据

```
e2e/
  src/                      API 层 e2e(vitest)
  ui/<名>.spec.ts           浏览器层回归脚本(入库)
  playwright.config.ts      回归配置: testDir ui,串行,失败时保留 trace 与截图
  archive/                  用户验收后的归档(入库)
    index.jsonl             验收记录,每次一行
    <运行号>/               一次运行的证据
  .runs/                    过程目录(不入库)
    <运行号>/               正在进行或未验收的运行
    test-results/  playwright-report/   回归运行产物
```

运行号格式 `YYYYMMDDHHMMSS-<名>`,`<名>` 只能用小写字母、数字、连字符,同时也是回归脚本的文件名。

### 一次运行的文件

| 文件 | 内容 | 归档 |
|---|---|---|
| `plan.json` | `intent`(用户原话)+ `scenarios[{id, title, expect[]}]` | 是 |
| `meta.json` | 运行号、被测地址、git 提交 / 分支 / 提交说明 / 是否有未提交改动、执行人、pwcli 版本、平台、起止时间 | 是 |
| `steps.jsonl` | 每步一行,见下 | 是 |
| `shots/NNN.png` | 每步截图 | 是 |
| `snapshots/NNN.yml` | 每步页面快照(已脱敏) | 是 |
| `regression.spec.ts` | 回归脚本草稿 | 是 |
| `regression.json` | 回归脚本路径、是否通过、输出末尾 30 行 | 是 |
| `verdict.json` | 用户结论 `result`、备注 `note`、`by`、`at` | 是 |
| `report.html` | 由以上文件生成的报告,双击即可打开 | 是 |
| `.playwright-cli/` | pwcli 自己写的原始快照、控制台日志、trace | **否**(含明文,见取舍) |
| `state.json` | 脚本运行状态 | 否 |

### steps.jsonl 字段

```jsonc
{
  "run": "20261008103550-login", "seq": 8, "ts": "2026-10-08T02:36:40.000Z",
  "scenario": "S2",
  "kind": "act",                              // act 操作 / check 检查
  // act
  "why": "提交登录",                           // 这一步要干什么
  "command": "click f1e16",                   // pwcli 命令(已脱敏)
  "code": "await page.getByRole('button', { name: '登录' }).click();",
  "replay": true,                             // 是否进回归脚本(snapshot、screenshot 等取证命令为 false)
  "result": "ok",                             // ok / error;check 为 pass / fail
  "error": null,
  // check
  "expect": "...", "actual": "...", "assert": "await expect(page).toHaveURL(/\\/users/);",
  // 两类都有
  "url": "http://localhost:7102/users?page=1&size=20", "title": "AIBase",
  "screenshot": "shots/008.png", "snapshot": "snapshots/008.yml",
  "newConsoleErrors": [], "newFailedRequests": []
}
```

### archive/index.jsonl 字段

`runId name intent baseUrl commit branch verdict note by at checksPassed checksFailed spec specPassed`

---

## 四、工程规范

### 场景与期望

- 每个场景至少一条**可观察**的期望:页面上看得见的,或者接口、控制台能验证的。"功能正常"这类说法不算期望。
- 场景 id 用 `S1`、`S2` 这种形式,标题写用户能看懂的话。
- plan 必须先给用户确认,再开始探索。

### 判定与断言

- `actual` 写**看到了什么**,不写结论。
- 不符合期望就如实判 fail。**不为了通过去改期望或断言。**
- 断言优先用 `toHaveURL`、`getByRole`、`getByText`、`getByLabel`,不用 CSS 选择器。
  前端组件**不专门为测试加 `data-testid`**,实在定位不到时才加。
- 每个检查点的 `--assert` 会原样进回归脚本;没写的会在草稿里留 `// TODO 断言`,入库前必须补上。

### 回归脚本

- 文件名 `ui/<名>.spec.ts`,与运行的 `<名>` 一致;一个文件对应一个用户意图。
- 不写死被测地址:`page.goto('/login')` 用相对路径,由 `E2E_BASE_URL` 或 `WEB_PORT` 决定。
- 不写明文密码,一律 `process.env[...]`;`playwright.config.ts` 会加载仓库根 `.env`。
- 入库前用 `regress` 跑一遍,结果写进报告,用户验收时能看到。
- 用户验收不通过时,脚本保不保留听用户的。

### 环境

- 被测地址先过 `doctor`:不只检查首页,还要求 `/api/health` 返回 ok。
  实际踩过的坑:端口被别的部署占着时,前端照样能打开,但接口全打到了别处。
- 生产环境不做写操作(新增、修改、删除数据),除非用户明确同意。

### 版本锁定(探索与回归必须同一内核)

playwright-cli 与 `@playwright/test` 都是本包(`e2e/package.json`)的开发依赖,**精确锁定且共用同一个 playwright-core**:

| 包 | 版本 |
|---|---|
| `@playwright/cli` | `0.1.22` |
| `@playwright/test` | `1.64.0-alpha-1790635538000`(= playwright-cli 0.1.22 依赖的内核版本) |

- **为什么不用 `@playwright/test` 正式版**: playwright-cli 每个版本依赖的都是 playwright 的 alpha 内核,
  与正式版要的浏览器版本不同(实测 1247 / 1248)。两套内核混用时,导航和快照正常,点击、输入却会静默失效。
  锁到同一内核后 pnpm 只装一份 playwright-core,只需要一套浏览器。
- **e2e-project 只用这里锁定的 playwright-cli**,不用全局安装的;沙箱若内置了版本不同的一份,doctor 会停下来让用户选。
- **升级规则(两个包一起升)**:
  1. `npm view @playwright/cli@<新版本> dependencies` 查它依赖的 `playwright-core` 版本号
  2. `@playwright/cli` 改成新版本,`@playwright/test` 改成第 1 步查到的同一个版本号
  3. `pnpm install`,`pnpm --filter @app/e2e exec playwright install chromium` 装新内核要的浏览器
  4. 用 e2e-project 跑一遍探索,再 `pnpm test:ui` 跑回归
- 浏览器按内核 `browsers.json` 要求的准确版本判断,目录里有别的版本不算;**绝不用软链冒充**。
- Linux 沙箱常缺中文字体(页面文字成空白方块、浏览器可能崩溃),e2e-project 的 doctor 会检查并按用户同意下载到用户目录。

---

## 五、取舍

| 选择 | 没选 | 理由 |
|---|---|---|
| AI 用 **playwright-cli** 探索 | Playwright MCP | CLI 不往上下文里塞工具定义和整棵无障碍树,快照落成文件,AI 按需读,省 token;每个动作直接给出等价代码 |
| **由 AI 探索,再沉淀成 spec** | 直接手写 spec;每次都由 AI 重新探索 | 手写成本高,也缺少"按用户意图验收"这一环;每次都探索又慢、又耗 token、结果不稳定。探索一次、固化成脚本,两边的好处都拿到 |
| 回归用 **@playwright/test 标准 spec** | 重放 steps.jsonl | ref 每次都会变,重放必挂;标准 spec 有现成的报告、trace、重试与 IDE 支持,不需要 AI 也能跑 |
| **记录脚本包一层 pwcli** | AI 直接调 pwcli、自己写记录 | 证据字段由脚本保证,AI 漏不掉;脱敏也集中在一处 |
| **用户验收**才归档 | AI 自己判定通过就归档 | e2e 验证的是"是否符合用户意图",只有用户能下这个结论 |
| 归档**入库** | 只留本地 | 结论要能追溯到代码版本,团队成员也能看到;实测登录验证 10 步,归档部分 235KB |
| `.playwright-cli/`(含 trace)**不归档** | 全部归档 | trace 会记下 fill 的明文和请求体,脚本无法脱敏;体积也大(同一次运行 17MB)。需要时去 `.runs/` 里看 |
| 场景串行、**共用一个会话** | 每个场景独立的浏览器上下文 | 和探索时的真实路径一致(登录一次,后面接着操作);代价是场景之间有依赖,单独跑后面的场景会失败 |
| 默认**无头** | 默认有头 | 沙箱和 CI 没有显示器;想看着跑时加 `--headed` |
| 语义定位器,**不强制加 testid** | 全部加 `data-testid` | 语义定位器还能顺带检查可访问性(按钮有名字、输入框有标签);testid 要改前端代码,而且和用户看到的东西脱节 |
| 取证前**固定等 800ms** | 等网络空闲 | 实现简单、对多数页面够用;不够时再 `act -- snapshot` 补一次。代价是每步多 0.8 秒 |
| 浏览器层**不进 `pnpm verify`** | 进 verify | 依赖浏览器和可访问的被测环境,沙箱里不一定有;API 层 e2e 已经在 verify 里 |

---

## 六、已知限制

- **skill 不在仓库里。** e2e-project skill(`.claude/skills/e2e-project/`)和 init-project、deploy-project 一样只在本机,不入库;
  仓库里只有它的产物(`ui/`、`archive/`)和回归配置。
- **只支持 chromium。** 回归配置只配了 chromium;要跑其他浏览器,在 `playwright.config.ts` 的 projects 里加。
- **场景之间有依赖。** 回归脚本串行共用一个会话,单独跑某个场景(`--grep`)可能因为缺少前置状态而失败。
- **回归会写数据。** 回归跑的是真实环境;涉及新增、修改的场景,重复运行会累积数据,需要在场景里自己清理,或者只对测试环境跑。
- **浏览器下载慢。** 默认从国外 CDN 下载,可以先设置 `PLAYWRIGHT_DOWNLOAD_HOST` 指向国内镜像。
