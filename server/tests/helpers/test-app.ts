/**
 * 路由测试夹具 —— 建一个连着临时库的完整 app,并准备好可用的登录态。
 *
 * 干什么: 一行拿到「app + 管理员 token + 只读用户 token」。
 * 解决什么问题: 每个路由测试文件都要重复"建库 -> 建上下文 -> 装配 -> 建管理员 -> 登录"
 *   这五步。抽出来之后测试文件只关心自己要验的东西。
 *
 * [关键] 它调用的是**生产的装配函数** buildModules —— 测试和 main.ts 用同一份装配。
 *   曾见过的一个项目的路由测试在 beforeEach 里手工 new 了 24 个 UseCase 把装配抄了第二份,
 *   于是装配改一次要同步改 N 个测试文件。
 */

import type { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { buildModules } from '../../src/composition/modules.js';
import { createContext, type AppContext } from '../../src/composition/context.js';
import { silentLogger } from '../../src/platform/logger/silent-logger.js';
import { ScryptPasswordHasher } from '../../src/modules/identity/infra/scrypt-password-hasher.js';
import { buildApp } from '../../src/composition/app.js';
import type { AppEnv } from '../../src/platform/http/env.js';
import { setupTestDb, type TestDb } from './test-db.js';

export const TEST_ADMIN = { username: 'admin', password: 'admin-pass-12345' };
export const TEST_VIEWER = { username: 'viewer', password: 'viewer-pass-12345' };
/** 有完整增删改查权限,但 dataScope=SELF —— 用来验行级数据权限。 */
export const TEST_SCOPED = { username: 'scoped', password: 'scoped-pass-12345' };
/** 能登录但一个权限码都没有 —— 用来验授权回归(每个受保护路由都挂了 requirePermission)。 */
export const TEST_NOBODY = { username: 'nobody', password: 'nobody-pass-12345' };

export interface TestApp {
  app: Hono<AppEnv>;
  ctx: AppContext;
  db: TestDb;
  /** 超管 token,拥有全部权限。 */
  adminToken: string;
  adminId: string;
  /** 只读用户 token,只有 user:read。用来验证权限拦截确实生效。 */
  viewerToken: string;
  viewerId: string;
  /**
   * 权限齐全但 dataScope=SELF 的用户 token。
   * 用来验行级数据权限:他只能看见/改动自己创建的数据。
   */
  scopedToken: string;
  scopedId: string;
  /** 零权限用户 token。授权回归靠它:任何受保护路由对它都该是 403。 */
  nobodyToken: string;
  cleanup: () => Promise<void>;
}

/** 带 Bearer token 发请求的小助手。 */
export const authed = (
  app: Hono<AppEnv>,
  token: string,
): ((path: string, init?: RequestInit) => Promise<Response>) => {
  return async (path, init = {}) =>
    app.request(path, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
    });
};

/** POST JSON 的小助手。 */
export const postJson = (
  app: Hono<AppEnv>,
  token: string,
  path: string,
  body: unknown,
): Promise<Response> =>
  authed(app, token)(path, { method: 'POST', body: JSON.stringify(body) });

export const setupTestApp = async (): Promise<TestApp> => {
  const db = await setupTestDb();
  const ctx = await createContext({
    connectionString: db.connectionString,
    schema: db.schema,
    logger: silentLogger,
  });
  const app = buildApp({
    ...(await buildModules(ctx)),
    version: '0.0.0-test',
    startedAt: new Date(),
  });

  const hasher = new ScryptPasswordHasher();
  const now = new Date();

  // 超管角色 + 账号
  const adminRoleId = uuidv7();
  await ctx.prisma.role.create({
    data: {
      id: adminRoleId,
      code: 'ADMIN',
      name: '超级管理员',
      superAdmin: true,
      builtin: true,
      dataScope: 'ALL',
      createdAt: now,
      updatedAt: now,
    },
  });

  const adminId = uuidv7();
  await ctx.prisma.user.create({
    data: {
      id: adminId,
      username: TEST_ADMIN.username,
      displayName: '管理员',
      passwordHash: await hasher.hash(TEST_ADMIN.password),
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      roles: { create: [{ roleId: adminRoleId }] },
    },
  });

  // 只读角色 + 账号:只给 user:read
  const viewerRoleId = uuidv7();
  await ctx.prisma.role.create({
    data: {
      id: viewerRoleId,
      code: 'VIEWER',
      name: '只读用户',
      superAdmin: false,
      builtin: false,
      dataScope: 'ALL',
      createdAt: now,
      updatedAt: now,
      permissions: { create: [{ code: 'user:read' }] },
    },
  });

  const viewerId = uuidv7();
  await ctx.prisma.user.create({
    data: {
      id: viewerId,
      username: TEST_VIEWER.username,
      displayName: '只读小王',
      passwordHash: await hasher.hash(TEST_VIEWER.password),
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      roles: { create: [{ roleId: viewerRoleId }] },
    },
  });

  // 行级权限用的角色: 权限给全,但 dataScope=SELF。
  // 与 VIEWER 分开是有意的 —— 一个用来验"权限码拦截",一个用来验"数据范围过滤",
  // 混在一个账号上会让失败的测试说不清到底是哪一层拦的。
  const scopedRoleId = uuidv7();
  await ctx.prisma.role.create({
    data: {
      id: scopedRoleId,
      code: 'SCOPED',
      name: '仅本人数据',
      superAdmin: false,
      builtin: false,
      dataScope: 'SELF',
      createdAt: now,
      updatedAt: now,
      permissions: {
        create: [
          { code: 'user:read' },
          { code: 'user:manage' },
          { code: 'role:read' },
          { code: 'role:manage' },
        ],
      },
    },
  });

  const scopedId = uuidv7();
  await ctx.prisma.user.create({
    data: {
      id: scopedId,
      username: TEST_SCOPED.username,
      displayName: '范围受限的小李',
      passwordHash: await hasher.hash(TEST_SCOPED.password),
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      roles: { create: [{ roleId: scopedRoleId }] },
    },
  });

  // 零权限角色 + 账号。能登录,但一个权限码都没有。
  const nobodyRoleId = uuidv7();
  await ctx.prisma.role.create({
    data: {
      id: nobodyRoleId,
      code: 'NOBODY',
      name: '无权限',
      superAdmin: false,
      builtin: false,
      dataScope: 'ALL',
      createdAt: now,
      updatedAt: now,
    },
  });

  await ctx.prisma.user.create({
    data: {
      id: uuidv7(),
      username: TEST_NOBODY.username,
      displayName: '路人甲',
      passwordHash: await hasher.hash(TEST_NOBODY.password),
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      roles: { create: [{ roleId: nobodyRoleId }] },
    },
  });

  const login = async (credentials: { username: string; password: string }): Promise<string> => {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    if (res.status !== 200) {
      throw new Error(`测试夹具登录失败(${res.status}): ${await res.text()}`);
    }
    return ((await res.json()) as { token: string }).token;
  };

  return {
    app,
    ctx,
    db,
    adminToken: await login(TEST_ADMIN),
    adminId,
    viewerToken: await login(TEST_VIEWER),
    viewerId,
    scopedToken: await login(TEST_SCOPED),
    scopedId,
    nobodyToken: await login(TEST_NOBODY),
    cleanup: async (): Promise<void> => {
      await ctx.prisma.$disconnect();
      await db.cleanup();
    },
  };
};
