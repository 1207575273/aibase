import { defineConfig } from 'vitest/config';

/**
 * e2e 配置。
 *
 * 与后端单测的区别: 这里起的是**真实服务进程**,走真实 HTTP,打真实数据库文件。
 * 覆盖的是单测覆盖不到的东西 —— 进程启动、配置加载、中间件顺序、
 * 响应头往返、真实网络层的行为。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.ts'],
    globalSetup: ['./src/global-setup.ts'],
    // 起进程 + 建库比单测慢,给足超时
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // 串行:所有用例共享同一个服务实例与数据库,并行会互相干扰
    fileParallelism: false,
  },
});
