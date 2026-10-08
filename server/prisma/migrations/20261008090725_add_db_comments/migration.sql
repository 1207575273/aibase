-- add_db_comments
-- 由 pnpm db migrate 生成。提交前通读一遍。


-- 表与字段注释: 依 schema.prisma 的 /// 生成,勿手改
COMMENT ON TABLE "sys_user" IS '系统用户。登录、授权与审计的主体;停用用 status 表达,不删除';
COMMENT ON COLUMN "sys_user"."id" IS '主键,UUID v7,由应用层 IdGenerator 生成';
COMMENT ON COLUMN "sys_user"."username" IS '登录名。唯一,不可修改(它是审计日志里的主体标识,改了历史日志就对不上人)';
COMMENT ON COLUMN "sys_user"."displayName" IS '页面上展示的姓名,可随时修改';
COMMENT ON COLUMN "sys_user"."passwordHash" IS 'PHC 风格哈希串: $scrypt$N=..,r=..,p=..$salt$dk。绝不出现在任何 wire 映射里';
COMMENT ON COLUMN "sys_user"."status" IS 'ACTIVE | DISABLED。值域由 domain 的 USER_STATUSES 约束';
COMMENT ON COLUMN "sys_user"."createdAt" IS '创建时间(UTC),由应用层 Clock 写入';
COMMENT ON COLUMN "sys_user"."updatedAt" IS '最后更新时间(UTC),由应用层 Clock 写入';
COMMENT ON COLUMN "sys_user"."createdBy" IS '创建人用户 id;种子创建的初始管理员为空';
COMMENT ON COLUMN "sys_user"."updatedBy" IS '最后更新人用户 id';
COMMENT ON TABLE "sys_role" IS '角色。权限码的集合,用户通过 sys_user_role 获得角色';
COMMENT ON COLUMN "sys_role"."id" IS '主键,UUID v7,由应用层 IdGenerator 生成';
COMMENT ON COLUMN "sys_role"."code" IS '大写下划线,如 ADMIN / OPERATOR。与权限码(小写冒号)形态不同,读日志时一眼可辨';
COMMENT ON COLUMN "sys_role"."name" IS '页面上展示的角色名';
COMMENT ON COLUMN "sys_role"."description" IS '角色用途说明';
COMMENT ON COLUMN "sys_role"."superAdmin" IS 'true = 绕过一切权限码校验。比通配符权限码更显式、可审计,且允许多个超管角色';
COMMENT ON COLUMN "sys_role"."builtin" IS 'true = 禁止删除、禁止改 code(可改名字和权限)。保证系统永远有一个可用的管理员角色';
COMMENT ON COLUMN "sys_role"."dataScope" IS 'ALL | SELF。行级数据权限,扩展成部门维度时在这里加值';
COMMENT ON COLUMN "sys_role"."createdAt" IS '创建时间(UTC),由应用层 Clock 写入';
COMMENT ON COLUMN "sys_role"."updatedAt" IS '最后更新时间(UTC),由应用层 Clock 写入';
COMMENT ON COLUMN "sys_role"."createdBy" IS '创建人用户 id;种子创建的内置角色为空';
COMMENT ON COLUMN "sys_role"."updatedBy" IS '最后更新人用户 id';
COMMENT ON TABLE "sys_user_role" IS '用户-角色 多对多。
两侧 onDelete 刻意不同:
  user Cascade  -> 删用户自动清关联,不留垃圾
  role Restrict -> 角色仍被引用时数据库直接拒绝删除,是 ROLE_IN_USE 的竞态兜底
                   (应用层会先 count 给出友好报错,这条是并发下的最后一道防线)';
COMMENT ON COLUMN "sys_user_role"."userId" IS '用户,删用户时关联一并删除';
COMMENT ON COLUMN "sys_user_role"."roleId" IS '角色,仍有用户引用时不允许删除角色';
COMMENT ON TABLE "sys_role_permission" IS '角色-权限码。
刻意**不建 Permission 表**: 权限码的真源在代码里(@app/contracts 的 PERMISSIONS 常量),
本表只存字符串引用。代码删掉某个 code 后,库里的残留行在读取时被 isKnownPermission
过滤掉即可,零数据迁移。';
COMMENT ON COLUMN "sys_role_permission"."roleId" IS '角色,删角色时它的权限码一并删除';
COMMENT ON COLUMN "sys_role_permission"."code" IS '权限码,小写冒号形式如 user:read;取值以 @app/contracts 的 PERMISSIONS 为准';
