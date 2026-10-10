# e2e-project 经验与教训

每条格式: **现象** -> 原因 -> 处理。

## playwright-cli

- **ref 找不到(Ref e15 not found in the current page snapshot)** -> 页面跳转或刷新后 ref 全部重新编号(还可能变成 f1e15 这种带前缀的) -> 每次操作后看脚本打印的最新快照文件再取 ref。
- **`--json` 输出里没有等价的 Playwright 代码和页面信息** -> 动作命令用普通输出,按 `### 段落` 解析;只有 generate-locator 这类只取结果的命令适合 `--raw`。
- **Windows 上调用 playwright-cli.cmd 中文参数被拆坏** -> spawn .cmd 必须开 shell -> 脚本改为用 node 直接跑 `npm root -g` 下的 `@playwright/cli/playwright-cli.js`。

## 证据与脱敏

- **密码出现在后续步骤的快照里**(`textbox "密码": admin12345`) -> 点击等步骤本身没引用密码变量,但密码框的值还在页面上 -> 脚本改为对本次运行用过的所有 `{{变量}}` 做脱敏。
- **`.playwright-cli/` 下的原始快照和 trace 含明文**(trace 会记下 fill 的值和请求体) -> pwcli 自己写的文件脚本管不到 -> 这个目录只留在不入库的 `.runs/` 里,归档时排除;不要把 trace 发给别人。
- **同一个请求失败两次只记了一次** -> 按文本和上一步去重 -> 改为按顺序增量比对(上一步是前缀就取新增部分)。
- **点击后截到的还是跳转前的页面** -> 跳转与接口请求是异步的 -> 取证前固定等 800ms;还不够就再 `act -- snapshot` 一次。

## 回归测试

- **回归报 Playwright 浏览器不存在,但 ms-playwright 目录里明明有 chromium** -> 有的是旧版本(1234),@playwright/test 1.64.0 要 1248,无头模式还要 chromium_headless_shell -> doctor 改为读 playwright-core 的 browsers.json 按准确版本判断。
- **浏览器下载很慢** -> 默认从国外 CDN 下载 -> 可设置 `PLAYWRIGHT_DOWNLOAD_HOST` 指向国内镜像后再装(先征得用户同意)。

## 被测环境

- **用 .env 的 SEED_ADMIN_PASSWORD 登录失败** -> 种子只在 admin 不存在时创建,库里的 admin 可能是之前用别的密码建的 -> 如实判定 fail,把情况告诉用户,由用户决定是否重置;不要擅自改库。

## 版本与浏览器

- **沙箱里点击、输入报成功但页面没变化,导航和快照却正常** -> playwright-cli 0.1.22 的内核要 chromium 1247,把 1248 软链成 1247 冒充,版本错配导致输入类命令静默失效 -> 绝不跨版本软链;两个包锁到同一内核(见下条),只装内核要的那一个版本。
- **playwright-cli 每个版本依赖的都是 playwright 的 alpha 内核,与 @playwright/test 正式版浏览器版本不同** -> 两者不可能"自然一致" -> playwright-cli 作为项目开发依赖精确锁定,@playwright/test 锁到与它相同的 alpha 内核版本,pnpm 合并成一份 playwright-core,只需一套浏览器。doctor 校验两者内核一致。
- **本机能跑、沙箱跑不起来** -> 不指定浏览器时 pwcli 优先用系统 Chrome(Windows 有,沙箱没有) -> start 打开时固定 `--browser=chromium`,两边都用锁定版本的 chromium。
- **沙箱以后可能内置 playwright-cli** -> 内置版本与项目锁定版本可能不同 -> doctor 检测到不一致时 NEED_CONFIRM cli-version,由用户选;选择记进 meta.cli,整次运行不换。

## 字体

- **截图里中文全是空白方块,输入时报 browser has been closed** -> 精简镜像没有任何字体,Chromium 文本处理依赖 fontconfig -> doctor 在 Linux 上检查中文字体,缺了按用户同意从 npm 镜像下载 @expo-google-fonts/noto-sans-sc(TTF,取常规与粗体)到 ~/.local/share/fonts/,生成 fonts.conf 并通过 FONTCONFIG_FILE 交给浏览器;不需要 root。woff2 格式的字体包不行,fontconfig 不认。
