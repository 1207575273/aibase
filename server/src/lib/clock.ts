/**
 * 时间来源端口。
 *
 * 干什么: 让 Service 通过注入拿"现在几点",而不是直接调 new Date()。
 * 解决什么问题: 测试里可以灌一个固定时刻,断言 createdAt 就是个确定值,
 *   不需要 fake timer,也不会出现"跑得快的时候 createdAt 和 updatedAt 差 1ms
 *   导致断言时灵时不灵"这种 flaky 测试。
 *
 * 用裸函数类型而不是自造 interface: 注入成本最低,测试里写 `() => FIXED` 就完事。
 *
 * [硬约束] 实体的 createdAt/updatedAt 一律由 Service 从这里取 now 显式赋值,
 * **禁止**用 Prisma 的 @default(now()) / @updatedAt,也禁止在 Repository 里
 * 偷写 `data.updatedAt = new Date()`。曾见过的一个项目两边都做了,结果是它 schema 注释
 * 声称"时间由领域层控制"但 update 路径的时间根本没法在测试里固定。
 */
export type Clock = () => Date;

/** 生产用的实现。composition 层注入。 */
export const systemClock: Clock = () => new Date();
