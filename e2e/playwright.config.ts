import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 浏览器回归测试(e2e/ui/*.spec.ts)。
 *
 * 这些脚本由 e2e-project skill 沉淀而来: AI 用 playwright-cli 按用户意图探索一遍,用户验收通过后,
 * 把操作代码固化成 spec。之后回归直接跑 spec,不再需要 AI。
 *
 * 被测地址: E2E_BASE_URL,默认本机前端 http://localhost:<WEB_PORT>(先 pnpm dev)。
 * 账号密码等从环境变量取(spec 里写 process.env['SEED_ADMIN_PASSWORD']),这里先加载仓库根的 .env。
 */
const rootEnv = path.resolve(import.meta.dirname, '../.env');
if (fs.existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  testDir: './ui',
  outputDir: './.runs/test-results',
  // 用例之间共享同一个库里的数据,串行跑,避免互相干扰
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: './.runs/playwright-report', open: 'never' }]],
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? `http://localhost:${process.env['WEB_PORT'] ?? '7102'}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
