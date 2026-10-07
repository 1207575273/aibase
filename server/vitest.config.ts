import { defineConfig } from 'vitest/config';

/**
 * 单一 vitest 配置。
 *
 * 干什么: 跑 src/ 与 tests/ 下的 *.test.ts。
 * 解决什么问题: 曾见过的一个项目有三份配置 + 三个 npm 脚本(单测 / 集成 / 全量),
 *   其中一份的 include glob 匹配零文件却没人发现。模板只留一档 ——
 *   测试要么跑要么不存在,不要"有一档从来没人跑过"。
 *
 * 为什么可以并行: 每个测试文件用自己的临时 schema(见 tests/helpers/test-db.ts,
 *   建 schema 后重放迁移 SQL),schema 显式传给 createPrismaClient
 *   而不是改全局 process.env,所以文件之间零共享状态。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    globalSetup: ['./tests/helpers/global-setup.ts'],
    // DATABASE_SCHEMA 是必填项。测试一律显式使用临时 schema,这里只是占位让 config 校验通过,
    // 名字故意不存在 —— 有代码误用它会直接报表不存在,而不是悄悄读写开发者的 _dev schema。
    env: { DATABASE_SCHEMA: 'tmp_test_placeholder' },
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
