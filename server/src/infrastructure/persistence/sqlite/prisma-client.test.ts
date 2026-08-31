/**
 * PRAGMA 回归护栏。
 *
 * 为什么值得专门写一个测试: PRAGMA 是典型的「设了就忘」配置 ——
 * 有人重构 createPrismaClient 时顺手删掉一行,代码照常跑、测试照常绿,
 * 但外键悄悄失效了、WAL 退回 delete 模式了,要到线上出数据问题才发现。
 * 这几行断言就是防这个的。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, type TestDb } from '../../../../tests/helpers/test-db.js';
import { resolveDbPath } from './prisma-client.js';

describe('createPrismaClient PRAGMA', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDb();
  });

  afterAll(async () => {
    await db.cleanup();
  });

  it('should_enable_wal_journal_mode', async () => {
    const rows = await db.prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>(
      'PRAGMA journal_mode',
    );
    expect(rows[0]?.journal_mode).toBe('wal');
  });

  it('should_enable_foreign_keys', async () => {
    // 这条最关键: 外键默认是关的,schema 里写的 onDelete 全靠它才生效
    const rows = await db.prisma.$queryRawUnsafe<Array<{ foreign_keys: bigint | number }>>(
      'PRAGMA foreign_keys',
    );
    expect(Number(rows[0]?.foreign_keys)).toBe(1);
  });

  it('should_set_busy_timeout', async () => {
    const rows = await db.prisma.$queryRawUnsafe<Array<{ timeout: bigint | number }>>(
      'PRAGMA busy_timeout',
    );
    expect(Number(rows[0]?.timeout)).toBe(5000);
  });

  it('should_cascade_delete_user_roles_when_user_removed', async () => {
    // 端到端验证外键真的在工作,而不只是 PRAGMA 值对。
    // 用 user -> userRole 这条关系:Session 表已随 JWT 改造删除,
    // 而级联删除本身仍然是必须被守住的行为 —— 它错了会留下悬空引用,
    // 且 SQLite 在外键关闭时**不会报错**,只会静默留下脏数据。
    const now = new Date();
    await db.prisma.user.create({
      data: {
        id: 'u1',
        username: 'alice',
        displayName: 'Alice',
        passwordHash: 'x',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      },
    });
    await db.prisma.role.create({
      data: {
        id: 'r1',
        code: 'TESTER',
        name: '测试角色',
        dataScope: 'SELF',
        superAdmin: false,
        builtin: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    await db.prisma.userRole.create({ data: { userId: 'u1', roleId: 'r1' } });

    await db.prisma.user.delete({ where: { id: 'u1' } });

    expect(await db.prisma.userRole.count()).toBe(0);
    // 角色本身不该被连带删掉 —— 级联只沿 user 这一侧
    expect(await db.prisma.role.count()).toBe(1);
  });


});

describe('resolveDbPath', () => {
  it('should_resolve_relative_path_against_repo_root', () => {
    const got = resolveDbPath('file:./data/app.db', '/repo');
    // 用 includes 而不是全等:Windows 上 resolve 会给出反斜杠 + 盘符
    expect(got.replace(/\\/g, '/')).toContain('/repo/data/app.db');
  });

  it('should_keep_absolute_path_as_is', () => {
    const abs = process.platform === 'win32' ? 'C:\\tmp\\a.db' : '/tmp/a.db';
    expect(resolveDbPath(`file:${abs}`, '/repo')).toBe(abs);
  });

  it('should_accept_url_without_file_prefix', () => {
    const got = resolveDbPath('data/app.db', '/repo');
    expect(got.replace(/\\/g, '/')).toContain('/repo/data/app.db');
  });
});
