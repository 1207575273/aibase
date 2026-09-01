/**
 * @app/contracts —— 前后端共享的 HTTP 线上契约,单一真源。
 *
 * 干什么: 一个地方定义「接口长什么样」,后端拿它校验请求 + 标注响应类型,
 *         前端拿它取类型 + 复用同一份表单校验规则。
 * 解决什么问题: 没有这个包时,前端只能手工镜像一份 TS 类型。改后端时前端不会编译报错,
 *         漂移只会在运行期以"字段是 undefined"的形式暴露出来。
 *
 * ── 设计要点 ──────────────────────────────────────────────────
 *
 * 1. 这是个**源码包**: exports 直指 ./src/index.ts,不产出构建物。
 *    前后端都用 moduleResolution: Bundler 直吃 TS 源码,改契约立刻生效,
 *    不需要 composite / project references / turborepo 那一套编排。
 *    [限制] 因此它永远不能 npm publish,也不能被非 bundler 环境消费。
 *
 * 2. **请求侧共享 zod schema,响应侧只用 TS 类型** —— 这个方向性分工是有原因的:
 *    z.date() 在后端 parse 时输入是 Date、前端 parse 时输入是 string,
 *    同一个 schema 表达不了这个方向性。曾见过的一个项目正是在这里踩过坑 ——
 *    它的响应 schema 从未被真正 parse 过,只当 z.infer 的模板用,是纯粹的死代码。
 *    所以响应走「纯 TS 类型 + 后端 toWire 函数标注返回类型」,由编译器保证形状;
 *    请求方向没有 Date 序列化问题,才共享 zod。
 *
 * 3. **导出类型一律 z.input,禁用 z.infer / z.output**:
 *    z.infer 等价于 output(默认值已填好),用它会让带 .default() 的字段
 *    在"客户端能发什么"这一面变成必填,合法调用被编译期误拦。
 *    契约描述的是请求方能发的形状,所以只能取 input。
 *
 * 4. 所有请求体一律 z.strictObject: 多余字段直接 400,不静默丢弃。
 */

// 有意的副作用导入:把 zod 内置错误消息切成中文。必须在其他导出之前。
import './locale.js';

export * from './common.js';
export * from './permissions.js';
export * from './auth.js';
export * from './user.js';
export * from './role.js';
