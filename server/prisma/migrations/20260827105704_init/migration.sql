-- ============================================================================
--  初始建表
-- ============================================================================
--
--  表名前缀约定:sys_ 系统表(框架自带) / biz_ 业务表。
--  数据库里一眼能分清哪些是骨架、哪些是业务,接手项目时不用逐张点开看。
--
--  几条全局约定(新增表照做):
--   1. 主键是 TEXT,存 UUID v7 —— 高位是毫秒时间戳,字典序≈时间序,
--      插入总在 B-tree 右端,不会像 v4 那样把页分裂散布到整棵树。
--   2. 每张表都带审计四件套 createdAt / updatedAt / createdBy / updatedBy,
--      时间由应用层从注入的 Clock 取值写入,不用数据库默认值(否则测试里没法固定时间)。
--   3. DATETIME 列由 driver adapter 以 INTEGER 毫秒存储(timestampFormat=unixepoch-ms)。
--      写原生 SQL 读时间时要注意:datetime(createdAt / 1000, 'unixepoch')。
--   4. 枚举用 TEXT 而不是 CHECK 约束 —— 值域由应用层的 as const 数组管,
--      加一个状态只改一行代码,零迁移。
--   5. 外键**要写**且运行时必须开 PRAGMA foreign_keys = ON(在 prisma-client.ts 里)。
--      不开的话下面这些 ON DELETE 规则全部静默失效,悄悄留下悬空引用。
--
-- ============================================================================


-- ─────────────────────────────────────────────────────────────
--  sys_user:系统用户(能登录的账号)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE "sys_user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    -- 登录名。唯一且不可修改 —— 它是审计日志里的主体标识,改了历史日志就对不上人
    "username" TEXT NOT NULL,
    -- 展示名,可以随便改
    "displayName" TEXT NOT NULL,
    -- PHC 风格哈希串: $scrypt$N=65536,r=8,p=2$<salt>$<dk>
    -- 自带算法名与成本参数,所以将来换算法不需要强制全员重置密码
    "passwordHash" TEXT NOT NULL,
    -- ACTIVE | DISABLED。禁用时会同步删掉该用户全部会话
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    -- 系统表的 createdBy 可空:seed 建的初始管理员没有"操作人"
    "createdBy" TEXT,
    "updatedBy" TEXT
);

-- ─────────────────────────────────────────────────────────────
--  sys_role:角色(用户与权限之间的中间层)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE "sys_role" (
    "id" TEXT NOT NULL PRIMARY KEY,
    -- 大写下划线,如 ADMIN / OPERATOR。与权限码(小写冒号分隔)形态不同,读日志时一眼可辨
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    -- true = 绕过一切权限码校验。
    -- 比通配符权限码(person:*)更显式、可审计,而且允许存在多个超管角色。
    -- 好处是新增业务模块时超管自动拥有新权限,不必回头补勾。
    -- [安全] 只能由 seed 创建,不开放给接口 —— 否则有 role:manage 权限的人
    -- 就能给自己造一个超管角色,等于提权后门
    "superAdmin" BOOLEAN NOT NULL DEFAULT false,
    -- true = 禁止删除、禁止改 code(可以改名字和权限集合)。
    -- 保证系统永远至少有一个可用的管理员角色
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    -- ALL | SELF。行级数据权限:SELF 只能看自己创建的业务数据。
    -- 扩展成部门维度时在这里加值,表结构不用动
    "dataScope" TEXT NOT NULL DEFAULT 'ALL',
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

-- ─────────────────────────────────────────────────────────────
--  sys_user_role:用户-角色 多对多
--
--  两侧 ON DELETE 刻意不同:
--    user Cascade  -> 删用户自动清关联,不留垃圾行
--    role Restrict -> 角色仍被引用时数据库直接拒绝删除。
--                     应用层会先 count 给出"还有 N 个用户在用"的友好报错,
--                     这条是并发下的最后一道防线,两者不是重复
-- ─────────────────────────────────────────────────────────────
CREATE TABLE "sys_user_role" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    PRIMARY KEY ("userId", "roleId"),
    CONSTRAINT "sys_user_role_userId_fkey" FOREIGN KEY ("userId") REFERENCES "sys_user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "sys_user_role_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "sys_role" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ─────────────────────────────────────────────────────────────
--  sys_role_permission:角色持有的权限码
--
--  [设计] 刻意**不建 Permission 表**。
--  权限码是代码产物不是运行时数据 —— 真源在 packages/contracts/src/permissions.ts
--  的 as const 数组。建表的话每加一个权限码都要写 seed/migration,漏写就是
--  "管理端勾不到这个权限",删接口后库里还留残留行。
--  本表只存字符串引用;代码里删掉某个 code 之后,残留行在读取时被
--  isKnownPermission() 过滤掉即可,零数据迁移。
--
--  复合主键天然去重,重复授权不会写脏数据。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE "sys_role_permission" (
    "roleId" TEXT NOT NULL,
    -- 形如 person:read。值域见 contracts 的 PERMISSIONS 常量
    "code" TEXT NOT NULL,

    PRIMARY KEY ("roleId", "code"),
    CONSTRAINT "sys_role_permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "sys_role" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ─────────────────────────────────────────────────────────────
--  sys_session:登录会话(不透明 token 的服务端载荷)
--
--  [安全] 库里只存 token 的 sha256,明文只在签发那一刻出现在 HTTP 响应里。
--  库被拖走也无法反推出可用的 token。
--
--  为什么用会话表而不是 JWT:单进程 SQLite 下 JWT 的"免 DB 往返"价值为零,
--  而它做不到强制下线、单点登出、权限变更立即生效 —— 那些恰恰是管理后台的刚需。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE "sys_session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    -- sha256(明文 token) 的 hex。唯一索引 = 每个请求的查找路径,必须有
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- 滑动过期:每次活跃往后推,但不能越过 absoluteExpiresAt
    "expiresAt" DATETIME NOT NULL,
    -- 绝对上限:无论多活跃,超过就必须重新登录。
    -- 没有它的话一个天天使用的账号会话可以永生,一次 token 泄漏就是永久失陷
    "absoluteExpiresAt" DATETIME NOT NULL,
    -- 上次活跃时间。用于节流续期写库 —— 每请求写一次事务的话,
    -- SQLite 单写者模型下这里会成为全站唯一的写热点
    "lastSeenAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL,
    -- 仅用于"我的登录设备"展示,写入时截断到 200 字符
    "userAgent" TEXT,
    "ip" TEXT,
    CONSTRAINT "sys_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "sys_user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ─────────────────────────────────────────────────────────────
--  biz_person:人员(模板自带的唯一示例业务)
--
--  新增业务表照抄这个形状:业务字段 + 审计四件套 + 该建的索引。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE "biz_person" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    -- 唯一。重复由数据库约束拦截,仓储把 P2002 翻译成 409。
    -- **不做**"先查后写"的前置查重 —— 那是 check-then-act 竞态
    "email" TEXT NOT NULL,
    "phone" TEXT,
    -- MALE | FEMALE | UNKNOWN
    "gender" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "department" TEXT,
    "position" TEXT,
    -- 入职日期,存 'YYYY-MM-DD' 字符串而**不是** DATETIME。
    -- 它是"哪一天"的业务概念,不带时刻也不带时区;
    -- 存成时间戳会引入时区问题(UTC 的 00:00 在东八区是 08:00,按天比较立刻出错)
    "hireDate" TEXT,
    -- ACTIVE | INACTIVE。在职状态用业务字段表达,
    -- **不用 deletedAt 软删** —— 软删会污染此后每一条查询,漏一个 where 就是数据泄漏
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "remark" TEXT,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    -- 业务表的 createdBy **非空**:业务数据必然由某个登录用户创建,
    -- 而且它同时是行级数据权限(dataScope=SELF)的过滤锚点 ——
    -- 允许为空就意味着有一批记录谁都过滤不到,那是个安全洞
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL
);


-- ============================================================================
--  索引
-- ============================================================================

-- 登录时按用户名精确查找
CREATE UNIQUE INDEX "sys_user_username_key" ON "sys_user"("username");
-- 用户列表按状态筛选
CREATE INDEX "sys_user_status_idx" ON "sys_user"("status");

CREATE UNIQUE INDEX "sys_role_code_key" ON "sys_role"("code");

-- 反查"某个角色有多少用户在用"—— 删角色前的 ROLE_IN_USE 检查走它
CREATE INDEX "sys_user_role_roleId_idx" ON "sys_user_role"("roleId");

-- [热路径] 每个受保护请求都要按 tokenHash 查一次会话,这个索引不能少
CREATE UNIQUE INDEX "sys_session_tokenHash_key" ON "sys_session"("tokenHash");
-- 按用户批量踢下线(禁用账号、重置密码时)
CREATE INDEX "sys_session_userId_idx" ON "sys_session"("userId");
-- 定时任务清理过期会话,防止会话表无限增长
CREATE INDEX "sys_session_expiresAt_idx" ON "sys_session"("expiresAt");

CREATE UNIQUE INDEX "biz_person_email_key" ON "biz_person"("email");
-- 列表页的状态筛选
CREATE INDEX "biz_person_status_idx" ON "biz_person"("status");
-- 列表页的部门筛选
CREATE INDEX "biz_person_department_idx" ON "biz_person"("department");
-- 列表默认排序(createdAt 倒序)
CREATE INDEX "biz_person_createdAt_idx" ON "biz_person"("createdAt");
-- 行级数据权限过滤(dataScope=SELF 时按创建人过滤)
CREATE INDEX "biz_person_createdBy_idx" ON "biz_person"("createdBy");
