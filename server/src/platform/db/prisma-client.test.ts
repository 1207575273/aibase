/**
 * 数据库行为护栏。
 *
 * 为什么值得专门写: 这里断言的都是「schema 里声明了、但没人会主动去验」的东西 ——
 * 外键的级联方向、唯一约束、事务回滚。有人重构 schema 时改错一个 onDelete,
 * 代码照常编译、业务测试照常绿,要到线上出数据问题才发现。
 *
 * [SQLite 时代这里测的是 PRAGMA] 那一套(WAL / foreign_keys / busy_timeout)
 * 是 SQLite 专有的,而且 foreign_keys 默认关闭、必须每个连接显式打开 ——
 * 忘了开就是外键静默失效。PG 没有这个坑(外键天生生效),
 * 所以护栏的重点从"配置有没有设对"转向"约束的语义有没有搞反"。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, type TestDb } from '../../../tests/helpers/test-db.js';
import { describeConnection } from './prisma-client.js';

describe('describeConnection', () => {
  it('should_hide_password_when_describing_connection', () => {
    const described = describeConnection(
      'postgresql://keel:super_secret_password@db.internal:5432/keel_prod',
    );

    // 这是安全断言,不是格式断言: 连接串整条进日志就是凭证泄漏
    expect(described).not.toContain('super_secret_password');
    expect(described).not.toContain('keel:');
    expect(described).toBe('db.internal:5432/keel_prod');
  });

  it('should_fall_back_to_placeholder_when_connection_string_is_invalid', () => {
    // 打印启动信息不该成为启动失败的原因
    expect(describeConnection('not a url')).toBe('(无法解析的连接串)');
  });
});

describe('数据库约束', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDb();
  });

  afterAll(async () => {
    await db.cleanup();
  });

  const now = new Date('2026-01-01T00:00:00.000Z');

  const makeRole = async (id: string, code: string): Promise<void> => {
    await db.prisma.role.create({
      data: {
        id,
        code,
        name: code,
        superAdmin: false,
        builtin: false,
        dataScope: 'ALL',
        createdAt: now,
        updatedAt: now,
      },
    });
  };

  const makeUser = async (id: string, username: string, roleId: string): Promise<void> => {
    await db.prisma.user.create({
      data: {
        id,
        username,
        displayName: username,
        passwordHash: 'x',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        roles: { create: [{ roleId }] },
      },
    });
  };

  it('should_cascade_delete_user_role_when_user_deleted', async () => {
    await makeRole('r-cascade', 'R_CASCADE');
    await makeUser('u-cascade', 'u_cascade', 'r-cascade');

    await db.prisma.user.delete({ where: { id: 'u-cascade' } });

    // onDelete: Cascade —— 删用户自动清关联,不留悬空引用
    expect(await db.prisma.userRole.count({ where: { userId: 'u-cascade' } })).toBe(0);
  });

  it('should_restrict_delete_role_when_still_referenced', async () => {
    await makeRole('r-restrict', 'R_RESTRICT');
    await makeUser('u-holder', 'u_holder', 'r-restrict');

    // onDelete: Restrict —— 这是 ROLE_IN_USE 的并发兜底。
    // 应用层会先 count 给出友好报错,但 check-then-act 在并发下必然有窗口,
    // 数据库这一层才是最后防线。方向搞反(写成 Cascade)会导致
    // "删角色把用户的角色关联静默删掉",而且没有任何报错。
    await expect(db.prisma.role.delete({ where: { id: 'r-restrict' } })).rejects.toThrow();

    expect(await db.prisma.role.count({ where: { id: 'r-restrict' } })).toBe(1);
  });

  it('should_reject_duplicate_username_at_database_level', async () => {
    await makeRole('r-uniq', 'R_UNIQ');
    await makeUser('u-uniq-1', 'same_name', 'r-uniq');

    // 唯一性靠 DB 约束,不是应用层 check-then-act
    await expect(
      db.prisma.user.create({
        data: {
          id: 'u-uniq-2',
          username: 'same_name',
          displayName: 'x',
          passwordHash: 'x',
          status: 'ACTIVE',
          createdAt: now,
          updatedAt: now,
        },
      }),
    ).rejects.toThrow();
  });

  it('should_roll_back_all_writes_when_transaction_throws', async () => {
    await makeRole('r-tx', 'R_TX');

    await expect(
      db.prisma.$transaction(async (tx) => {
        await tx.role.update({ where: { id: 'r-tx' }, data: { name: '改了一半' } });
        throw new Error('故意失败');
      }),
    ).rejects.toThrow('故意失败');

    // 事务里抛异常必须整体回滚 —— UnitOfWork 的正确性依赖这条
    const role = await db.prisma.role.findUniqueOrThrow({ where: { id: 'r-tx' } });
    expect(role.name).toBe('R_TX');
  });

  it('should_preserve_millisecond_precision_when_storing_timestamps', async () => {
    const precise = new Date('2026-03-04T05:06:07.123Z');
    await db.prisma.role.create({
      data: {
        id: 'r-time',
        code: 'R_TIME',
        name: 'time',
        superAdmin: false,
        builtin: false,
        dataScope: 'ALL',
        createdAt: precise,
        updatedAt: precise,
      },
    });

    // 列类型是 TIMESTAMP(3) —— 毫秒必须原样存回来。
    // 精度掉了的话,"同一次创建的 createdAt 与 updatedAt 严格相等"这类断言
    // 会变成偶发失败,极难定位。
    const row = await db.prisma.role.findUniqueOrThrow({ where: { id: 'r-time' } });
    expect(row.createdAt.toISOString()).toBe('2026-03-04T05:06:07.123Z');
  });
});
