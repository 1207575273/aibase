-- 初始结构:用户 / 角色 / 用户-角色 / 角色-权限码
--
-- 这是 PostgreSQL 化之后的第一条迁移。SQLite 时代的迁移已全部作废删除 ——
-- 两者的 DDL 不兼容(类型系统、约束语法、索引写法都不同),没法共存也没法转换。
--
-- ── 几个刻意的设计,改之前先读 schema.prisma 的头注释 ──────────────
--
-- 1. id 是 TEXT 而不是 SERIAL / UUID 类型: 应用层用 UUID v7 字符串生成。
--    v7 高位是毫秒时间戳,字典序约等于时间序,既有随机 id 的好处又不破坏索引局部性。
--    不用数据库自增,是因为那会让「插入前拿不到 id」这件事污染整个应用层。
--
-- 2. createdAt / updatedAt 是 TIMESTAMP(3) 且**没有 DEFAULT**:
--    时间一律由应用层注入的 Clock 产生。有 DEFAULT now() 的话,测试里就没法
--    把时间钉死,「同一次创建的两个时间戳严格相等」这种可断言的事实也会丢掉。
--
-- 3. createdBy / updatedBy 可空: 系统表由 seed 灌入时还没有「操作人」。
--    这些无主行对 dataScope=SELF 的主体不可见,是行级数据权限的正确行为。
--
-- 4. status / dataScope 用 TEXT 而不是 PG 原生 enum: 加一个枚举值就得写
--    ALTER TYPE 迁移(且旧版 PG 里那条语句不能在事务内执行),
--    而值域用应用层的 as const 数组约束可以零迁移。
--
-- 5. 两个外键的 ON DELETE **刻意不同**:
--    - sys_user_role.userId  CASCADE  删用户自动清关联,不留垃圾
--    - sys_user_role.roleId  RESTRICT 角色仍被引用时数据库直接拒绝删除。
--      这是 ROLE_IN_USE 的并发兜底 —— 应用层会先 count 给出友好报错,
--      但 check-then-act 在并发下必然有窗口,DB 约束才是最后一道防线。
--
-- 6. 不建 Permission 表: 权限码的真源在代码里(contracts/src/permissions.ts),
--    sys_role_permission 只存字符串引用。代码里删掉某个 code 之后,
--    库里的残留行在读取时被过滤掉即可,零数据迁移。

-- CreateTable
CREATE TABLE "sys_user" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "sys_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sys_role" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "superAdmin" BOOLEAN NOT NULL DEFAULT false,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "dataScope" TEXT NOT NULL DEFAULT 'ALL',
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "sys_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sys_user_role" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "sys_user_role_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "sys_role_permission" (
    "roleId" TEXT NOT NULL,
    "code" TEXT NOT NULL,

    CONSTRAINT "sys_role_permission_pkey" PRIMARY KEY ("roleId","code")
);

-- CreateIndex
CREATE UNIQUE INDEX "sys_user_username_key" ON "sys_user"("username");

-- CreateIndex
CREATE INDEX "sys_user_status_idx" ON "sys_user"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sys_role_code_key" ON "sys_role"("code");

-- CreateIndex
CREATE INDEX "sys_user_role_roleId_idx" ON "sys_user_role"("roleId");

-- AddForeignKey
ALTER TABLE "sys_user_role" ADD CONSTRAINT "sys_user_role_userId_fkey" FOREIGN KEY ("userId") REFERENCES "sys_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sys_user_role" ADD CONSTRAINT "sys_user_role_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "sys_role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sys_role_permission" ADD CONSTRAINT "sys_role_permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "sys_role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
