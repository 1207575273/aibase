import { expect, test, type Page } from '@playwright/test';

/**
 * 由 e2e-project 运行 20261008103550-login 生成(版本 d08238b)。
 * 用户意图: 验证登录功能: 密码错了要有提示, 管理员能正常登录进系统
 */
test.describe.serial("login", () => {
  let page: Page;

  test.beforeAll(async ({ browser }, testInfo) => {
    const { baseURL } = testInfo.project.use;
    page = await browser.newPage(baseURL === undefined ? {} : { baseURL });
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test("S1 错误密码登录", async () => {
    await page.goto('/login');
    await page.getByRole('textbox', { name: '用户名' }).fill('admin');
    await page.getByRole('textbox', { name: '密码' }).fill('wrong-password');
    await page.getByRole('button', { name: '登录' }).click();
    // 检查: 停留在登录页
    await expect(page).toHaveURL(/\/login/);
    // 检查: 提示用户名或密码错误
    await expect(page.getByText('用户名或密码错误')).toBeVisible();
  });

  test("S2 管理员正常登录", async () => {
    await page.getByRole('textbox', { name: '密码' }).fill(process.env['SEED_ADMIN_PASSWORD']!);
    await page.getByRole('button', { name: '登录' }).click();
    // 检查: 登录后离开登录页进入系统
    await expect(page).toHaveURL(/\/users/);
    // 检查: 页面上能看到当前用户 admin
    await expect(page.getByRole('button', { name: '系统管理员' })).toBeVisible();
  });
});
