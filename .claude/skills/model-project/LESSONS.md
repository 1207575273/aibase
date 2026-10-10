# model-project 经验与教训

每条格式: **现象** -> 原因 -> 处理。

- **Studio Visualizer 里一张表都没有** -> 默认打开 public schema,项目的表在 `<项目>_dev` 里 -> 地址带 `#schema=<DATABASE_SCHEMA>&view=schema`,或左上角切换。
- **Visualizer 连线上的 1:1 / 1:n 标签不准**(n-n 中间表的连线也标成 1:1) -> Studio 按外键画线,基数标签不可靠 -> Visualizer 只用来核对表、字段、外键连线是否存在;基数与删除策略以迁移 SQL 和 `check.mjs schema` 为准。
- **停掉 `pnpm db studio` 的后台任务后端口仍被占、目录删不掉** -> Windows 上结束外层 shell 不会结束它启动的 node 子进程 -> 用完 Studio 后按命令行找到含 `studio` 的 node 进程一并结束。
