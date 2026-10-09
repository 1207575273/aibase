# init-project 经验与教训

每条格式: **现象** -> 原因 -> 处理。

- **用 fetch 下载 GitLab 归档包返回 406,内容为空**(curl 正常) -> fetch(undici)强制附加 `sec-fetch-mode` 等浏览器请求头,改 Accept 也没用 -> 改用 `node:http` / `node:https` 下载。
- **沙箱镜像里没有 curl,也不一定有 tar / unzip** -> 外部工具不可依赖 -> 下载用 node:http,gzip 用 node:zlib,tar 用纯 Node 解包;提交号用 `git get-tar-commit-id` 从包头读取(git 本来就是必需的)。
- **为什么不用 git clone** -> 克隆会带上模板仓库的远端与历史,业务代码可能被误推到公共模板仓库 -> 只下载归档包,本地 `git init`,首次提交后校验没有任何远端。
