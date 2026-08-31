/**
 * 权限码目录 —— 全系统唯一真源。
 *
 * 干什么: 用一个 as const 数组定义所有权限码,派生出 PermissionCode 联合类型。
 * 解决什么问题:
 * - 权限码是**代码产物**不是运行时数据 —— 新增一个接口才会有新权限码。所以不建
 *   Permission 表:建了就意味着每加一个权限码都要写 seed/migration,漏写就是
 *   "管理端勾不到这个权限",删接口后库里还留残留行。真源在代码,零迁移。
 * - 派生出联合类型后,`requirePermission('person:creat')` 这种拼写错误是**编译错误**
 *   而不是运行期的"这个接口谁都能调"。
 *
 * 为什么放在 contracts 包而不是后端 domain:
 *   权限码要被三方消费 —— 后端路由声明、前端按钮显隐、管理端权限树渲染。
 *   contracts 是前后端唯一的共享落点。
 *   注意 domain 层受 R3 约束不能 import 本包,所以 domain 内部的 hasPermission()
 *   形参类型是裸 string(它只做 Set.has,不需要联合类型)。类型安全落在真正需要的
 *   两处:interface 层的 requirePermission() 和前端的 can()。
 *
 * 新增一个业务模块的完整流程:
 *   1. 在下面的 PERMISSIONS 加几行
 *   2. 路由上挂 requirePermission('xxx:yyy')
 *   3. 管理端权限树自动多出这几项,管理员给角色勾选即可
 *   全程零迁移、零 seed 改动。
 */

/** 权限码分组,仅用于管理端权限树的分组展示。 */
export const PERMISSION_GROUPS = ['系统管理'] as const;
export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export const PERMISSIONS = [
  // ── 系统管理 ──
  // 读写只拆两档而不是四个 CRUD:管理面是低频操作,且"能进这个页面改东西的人"
  // 本来就该能增删。粒度按真实使用场景定,不为对称而对称。
  { code: 'user:read', label: '查看用户', group: '系统管理' },
  { code: 'user:manage', label: '管理用户', group: '系统管理' },
  { code: 'role:read', label: '查看角色', group: '系统管理' },
  { code: 'role:manage', label: '管理角色', group: '系统管理' },
] as const satisfies ReadonlyArray<{
  code: string;
  label: string;
  group: PermissionGroup;
}>;

/** 全部合法权限码的联合类型。拼错即编译错误。 */
export type PermissionCode = (typeof PERMISSIONS)[number]['code'];

export const PERMISSION_CODES: readonly PermissionCode[] = PERMISSIONS.map((p) => p.code);

const CODE_SET: ReadonlySet<string> = new Set<string>(PERMISSION_CODES);

/**
 * 判断一个字符串是不是当前代码里还存在的权限码。
 *
 * 用途: 库里 role_permission 表存的是字符串快照。如果某次发版删掉了一个权限码,
 * 残留行会被这个函数过滤掉 —— 行为是对的(已删除的权限不该继续生效),
 * 且不需要写数据清理迁移。
 */
export const isKnownPermission = (code: string): code is PermissionCode => CODE_SET.has(code);
