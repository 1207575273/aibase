/**
 * Prisma 生成物的唯一出口(barrel)。
 *
 * 干什么: 全仓所有对 PrismaClient / Prisma 命名空间的 import 都必须经过这里。
 * 解决什么问题: 生成目录的位置和包名在 Prisma 大版本之间变过好几次
 * (@prisma/client -> 自定义 output 目录)。收敛成一个文件后,
 * 将来再变只需要改这一行,而不是全仓 grep 替换。
 */
export { PrismaClient, Prisma } from '../../../generated/prisma/client.js';
export type { Prisma as PrismaTypes } from '../../../generated/prisma/client.js';
