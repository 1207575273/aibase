import { defineConfig } from 'vitest/config';

/**
 * 单一 vitest 配置。
 *
 * 干什么: 跑 src/ 与 tests/ 下的 *.test.ts。
 * 解决什么问题: 曾见过的一个项目有三份配置 + 三个 npm 脚本(单测 / 集成 / 全量),
 *   其中一份的 include glob 匹配零文件却没人发现。模板只留一档 ——
 *   测试要么跑要么不存在,不要"有一档从来没人跑过"。
 *
 * 为什么可以并行: 每个测试文件用自己的独立 database(见 tests/helpers/test-db.ts,
 *   靠 CREATE DATABASE ... TEMPLATE 从模板库克隆),连接串显式传给 createPrismaClient
 *   而不是改全局 process.env,所以文件之间零共享状态。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    globalSetup: ['./tests/helpers/global-setup.ts'],
    // 单个用例超过 15s 基本就是卡死而不是慢,早点失败早点看到。
    testTimeout: 15_000,
    /*
     * 夹具超时要比用例宽松得多。
     *
     * setupTestApp 会建四个账号(admin / viewer / scoped / nobody)并逐个登录,
     * 也就是 8 次 scrypt —— 每次 64MiB、上百毫秒,多个测试文件并行时还要抢 CPU。
     * 默认的 10 秒会被这一步顶穿,表现为"Hook timed out"后**全部用例被跳过**,
     * 看起来像测试挂了,实际只是夹具没来得及建完。
     */
    hookTimeout: 60_000,
    clearMocks: true,
  },
});
