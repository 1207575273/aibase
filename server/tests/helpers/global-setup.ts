/**
 * vitest 全局前置 —— 建一次「模板数据库」,供所有测试文件复制。
 *
 * 干什么: 在跑任何测试之前,用真实的 prisma migrate deploy 建一个空库,
 *         压成自包含单文件放到临时目录。每个需要数据库的测试再 copyFileSync 一份副本。
 *
 * 解决什么问题:
 *   直接让每个测试自己跑一次 prisma CLI 建库要 ~2 秒,几百个用例就是十几分钟,
 *   TDD 的反馈循环直接废掉。而 mock 掉仓储又拿不到"SQL 到底对不对"的置信度。
 *   模板库 + 文件复制把成本压到毫秒级 —— 既连真库又够快,是姊妹项目
 *   work_nm_tp 全仓最值钱的一段工程资产,直接继承。
 *
 * 相对姊妹项目的两处改进:
 * 1. 用 `migrate deploy` 而不是 `db push` 建模板库。
 *    db push 是拿 schema.prisma 直接推,**根本不碰 migrations 目录** ——
 *    它 1545 个用例全程没跑过一次真实迁移,schema 与 migration 漂移对测试完全不可见。
 *    用 deploy 意味着"迁移文件本身"也在测试覆盖之下。
 * 2. 模板库文件名带 pid,并且不改全局 process.env。
 *    姊妹项目靠改 process.env.DATABASE_URL 给 PrismaClient 传参,直接导致
 *    vitest 必须 singleThread 串行跑;模板库路径还写死在固定文件名,
 *    两个并发 vitest 进程会互删互建。这里两个问题一起修掉,测试可以并行。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

/** 模板库路径通过环境变量传给各测试文件 —— 这是唯一需要跨进程共享的一个值。 */
export const TEMPLATE_DB_ENV = 'TEST_TEMPLATE_DB';

let workDir: string | undefined;

export const setup = (): void => {
  // 带 pid 后缀:多个 vitest 进程(比如同时跑 watch 和一次性运行)不会互相踩。
  workDir = mkdtempSync(join(tmpdir(), `app-test-db-${process.pid}-`));
  const templateDb = join(workDir, 'template.db');

  // 用 prisma CLI 建库。走 DATABASE_URL 环境变量传参给子进程,不污染当前进程。
  // stdio: 'inherit' —— 迁移失败时必须让人看见 prisma 的报错。
  // 姊妹项目这里用了 stdio:'pipe' 把错误吞掉,建库失败只会表现为
  // 后续测试莫名其妙全红,排查要绕一大圈。
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: `file:${templateDb}` },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (!existsSync(templateDb)) {
    throw new Error(`模板库建立失败,预期路径不存在: ${templateDb}`);
  }

  process.env[TEMPLATE_DB_ENV] = templateDb;
};

export const teardown = (): void => {
  if (workDir !== undefined) {
    rmSync(workDir, { recursive: true, force: true });
  }
};
