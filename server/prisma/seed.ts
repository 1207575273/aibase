/**
 * 数据种子 —— 灌出一套「clone 下来就能登录并看到东西」的初始数据。
 *
 * 干什么: 建两个内置角色 + 一个管理员账号。
 * 解决什么问题: 权限模块没有种子角色根本跑不起来(没人能登录);
 *   示例数据则让新人第一次打开页面就能看到分页、搜索、筛选是怎么工作的。
 *
 * [幂等] 全部用 upsert —— 重复执行不会报错也不会产生重复数据。
 *   这很重要:`prisma migrate reset` 会自动调用它,而且开发中经常要手工重跑。
 *
 * 运行: pnpm db:seed
 */

import { PERMISSION_CODES } from '@app/contracts';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { createPrismaClient } from '../src/infrastructure/persistence/postgres/prisma-client.js';
import { ScryptPasswordHasher } from '../src/infrastructure/security/scrypt-password-hasher.js';
import { config } from '../src/config/index.js';

const ADMIN_ROLE_CODE = 'ADMIN';
const VIEWER_ROLE_CODE = 'VIEWER';
const ADMIN_USERNAME = 'admin';


const main = async (): Promise<void> => {
  const prisma = await createPrismaClient({ connectionString: config.databaseUrl });
  const hasher = new ScryptPasswordHasher();
  const now = new Date();

  // ── 角色 ────────────────────────────────────────────────────
  // ADMIN 是超管: superAdmin=true 让它绕过一切权限码校验,
  // 所以将来新增业务模块时不需要回头给它补勾新权限。
  const adminRole = await prisma.role.upsert({
    where: { code: ADMIN_ROLE_CODE },
    update: {},
    create: {
      id: uuidv7(),
      code: ADMIN_ROLE_CODE,
      name: '超级管理员',
      description: '拥有全部权限,不可删除',
      superAdmin: true,
      builtin: true,
      dataScope: 'ALL',
      createdAt: now,
      updatedAt: now,
    },
  });

  // VIEWER 是只读角色,同时也是"权限码怎么用"的活样板。
  const viewerRole = await prisma.role.upsert({
    where: { code: VIEWER_ROLE_CODE },
    update: {},
    create: {
      id: uuidv7(),
      code: VIEWER_ROLE_CODE,
      name: '只读用户',
      description: '只能查看,不能增删改',
      superAdmin: false,
      builtin: true,
      dataScope: 'ALL',
      createdAt: now,
      updatedAt: now,
    },
  });

  // 只读角色的权限:只给 user:read。
  // 用 upsert 逐条写而不是 createMany + skipDuplicates:PG 是支持 skipDuplicates 的,
  // 但这里要的语义是"存在就跳过、不存在就建",upsert 表达得更直接,
  // 而且条数是个位数,批量插没有性能意义。
  for (const code of ['user:read'] as const) {
    await prisma.rolePermission.upsert({
      where: { roleId_code: { roleId: viewerRole.id, code } },
      update: {},
      create: { roleId: viewerRole.id, code },
    });
  }

  // ── 管理员账号 ──────────────────────────────────────────────
  const existingAdmin = await prisma.user.findUnique({ where: { username: ADMIN_USERNAME } });

  if (existingAdmin === null) {
    // 密码取 SEED_ADMIN_PASSWORD。.env.example 里给了固定值 admin12345,
    // 方便 clone 下来就能登录。真的一个都没设(比如容器里没挂 .env)时
    // 随机生成并打印一次,而不是退回某个人尽皆知的默认密码 ——
    // 那种默认值会一路带到生产环境。
    const envPassword = process.env['SEED_ADMIN_PASSWORD'];
    const password = envPassword ?? randomBytes(9).toString('base64url');

    const admin = await prisma.user.create({
      data: {
        id: uuidv7(),
        username: ADMIN_USERNAME,
        displayName: '系统管理员',
        passwordHash: await hasher.hash(password),
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        // createdBy 为 null:此刻还没有"操作人",这正是系统表审计字段可空的原因
        roles: { create: [{ roleId: adminRole.id }] },
      },
    });

    process.stdout.write(
      [
        '',
        '='.repeat(60),
        '  管理员账号已创建',
        `  用户名: ${ADMIN_USERNAME}`,
        `  密  码: ${password}`,
        envPassword === undefined
          ? '  [WARN] 密码为随机生成,只显示这一次,请立即记录并在登录后修改'
          : '  [INFO] 密码来自环境变量 SEED_ADMIN_PASSWORD',
        '='.repeat(60),
        '',
      ].join('\n'),
    );
    void admin;
  } else {
    process.stdout.write('[SKIP] 管理员账号已存在,未改动密码\n');
  }

  process.stdout.write(
    `[INFO] 权限码共 ${PERMISSION_CODES.length} 个,真源在 contracts/src/permissions.ts\n`,
  );

  await prisma.$disconnect();
};

main().catch((e: unknown) => {
  process.stderr.write(`[FAIL] seed 失败: ${String(e)}\n`);
  process.exit(1);
});
