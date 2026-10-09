// init-project 的配置。改模板来源、默认分支、端口段只改这里。

export default {
  // 模板仓库: 只下载归档包,不 git clone(新项目是独立仓库,不会误推到模板仓库)
  template: {
    // 模板仓库所在的 GitLab 地址
    gitlab: 'https://git.landray.com.cn',
    // 项目路径(网页地址里域名之后的那一段)
    project: 'mk-group/v5/saasservice/ts-asset/ts-nodejs-template',
    // 只读访问令牌: 该项目的 Project Access Token,权限 read_api,只能读这一个项目、不能写。
    // 放在请求头里,不进 URL、日志与 projects.json。泄露时到项目 Settings -> Access Tokens 撤销并换新
    token: '<已撤销>',
  },

  // 默认下载的分支或 tag,可用 --ref 临时覆盖
  templateRef: 'main',

  // 模板自身的项目名: 初始化时把它批量改成新项目名(包名、库名、schema 前缀等)
  templateName: 'aibase',

  // 模板自身的显示名: 初始化时改成新项目的 --title
  templateTitle: 'AIBase',

  // 模板占用的端口段(71 -> 7101 / 7102 ...): 新项目改成 --segment;--check-ports 从它的下一段开始找空闲段
  templatePortSegment: 71,
};
