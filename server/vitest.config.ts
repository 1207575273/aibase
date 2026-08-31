import { defineConfig } from 'vitest/config';

/**
 * 单一 vitest 配置。
 *
 * 干什么: 跑 src/ 与 tests/ 下的 *.test.ts。
 * 解决什么问题: 姊妹项目有三份配置 + 三个 npm 脚本(单测 / 集成 / 全量),
 *   其中一份的 include glob 匹配零文件却没人发现。模板只留一档 ——
 *   测试要么跑要么不存在,不要"有一档从来没人跑过"。
 *
 * 为什么可以并行: 每个测试文件用自己的临时 SQLite 副本(见 tests/helpers/test-db.ts),
 *   库路径显式传给 createPrismaClient 而不是改全局 process.env,所以文件之间零共享状态。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    globalSetup: ['./tests/helpers/global-setup.ts'],
    // 单个用例超过 15s 基本就是卡死而不是慢,早点失败早点看到。
    testTimeout: 15_000,
    clearMocks: true,
  },
});
