/**
 * zod 全局中文化。
 *
 * 干什么: 把 zod 内置的校验错误消息切成简体中文。
 * 解决什么问题: 不配置的话,没有显式传 message 的规则会返回英文
 * (如 "Too small: expected string to have >=1 characters"),
 * 而这些消息会经 handle-error 原样进 details.issues,最终显示在用户表单上。
 * 逐条手写 message 是不现实的,全局 locale 一次解决。
 *
 * [注意] 这是**有意的导入副作用** —— index.ts 顶部 import 本模块即生效,
 * 前后端任何一端只要 import 了 @app/contracts 就自动中文化,不需要记得调用某个初始化函数。
 * 副作用一般应当避免,这里是权衡后的例外:漏调用的代价(线上蹦出英文报错)
 * 比隐式副作用的代价更高,而这个副作用是幂等且无害的。
 */
import { z } from 'zod';

z.config(z.locales.zhCN());
