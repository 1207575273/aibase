// init-project 的配置。改模板名、端口段只改这里。
// 模板源码在 assets/template.tar.gz(由 scripts/pack.mjs 从模板仓库打出),不联网下载。

export default {
  // 模板自身的项目名: 初始化时把它批量改成新项目名(包名、库名、schema 前缀等)
  templateName: 'aibase',

  // 模板自身的显示名: 初始化时改成新项目的 --title
  templateTitle: 'AIBase',

  // 模板占用的端口段(71 -> 7101 / 7102 ...): 新项目改成 --segment;--check-ports 从它的下一段开始找空闲段
  templatePortSegment: 71,
};
