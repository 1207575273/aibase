/**
 * 操作主体(Actor)—— 「谁在做这件事」。
 *
 * 干什么: 认证中间件解析出它,显式传给每个需要主体的 Service 方法,
 *         用于权限判定、行级数据过滤、审计字段填充。
 *
 * 解决什么问题:
 *   姊妹项目 work_nm_tp 的 38 张表零个 createdBy、UseCase 入参里没有 actor、
 *   契约里没有 Principal —— 意味着后补鉴权时要动 schema、动全部 UseCase 签名、
 *   动全部 wire 映射。「主体」这条线必须一开始就预埋,哪怕暂时只填 system。
 *
 * ── 为什么显式传参而不用 AsyncLocalStorage ──────────────────────
 *
 * 结论: `service.method(input, actor)` 两个参数,actor 显式传。
 *
 * 1. **依赖显式化是这套架构的立身之本**。所有依赖都走构造注入,测试只需要
 *    `new UserService({ repo, clock })` 写字面量、零 vi.mock。ALS 会让"当前用户"
 *    成为唯一一个从全局变量里读的依赖,破坏这个不变量 —— 测试要写
 *    `als.run(fakeActor, () => ...)` 包裹,可测性从"零心智"退化成"要先懂 ALS"。
 *
 * 2. **编译器兜底 vs 运行期爆炸**。显式传参下,忘了传主体是**编译错误**;
 *    ALS 下,忘了在某条路径(定时任务、CLI、seed、单测)建立上下文是**运行期 undefined**,
 *    而且往往在生产的边缘路径才炸。对一个要被 clone 很多次的模板,前者的失败模式
 *    好一个数量级。
 *
 * 3. **ALS 有跨异步边界丢上下文的真实坑**: 手写 Promise 构造器、某些第三方回调、
 *    跨请求复用的 EventEmitter、流式响应里的延后回调,都可能拿不到或拿错上下文。
 *    这类 bug 极难复现。
 *
 * 4. **收益不成立**。ALS 的价值在"调用链极深、中间层与主体无关、不想污染 N 层签名"。
 *    这里调用链只有 route -> service -> repository 三层,而且 repository 天然不该
 *    知道主体(行级过滤条件由 Service 算好后当普通查询字段传下去,这本身就是正确分层)。
 *    要污染的签名只有一层。
 */

/** 数据权限范围。与契约里的 DATA_SCOPES 同值域(domain 受 R3 约束不能 import 契约)。 */
export const DATA_SCOPES = ['ALL', 'SELF'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

export interface ActorContext {
  /** 当前用户 id。系统内部调用为 SYSTEM_ACTOR_ID。 */
  readonly actorId: string;
  readonly username: string;
  readonly roleCodes: readonly string[];
  /** 超管:hasPermission 恒真。 */
  readonly superAdmin: boolean;
  readonly dataScope: DataScope;
  /**
   * 权限码集合。用 Set 是因为它每请求要被查若干次。
   *
   * 类型是 string 而不是契约里的 PermissionCode 联合 —— domain 受 R3 约束
   * 不能 import 契约包。这里只做 has() 查询,不需要联合类型;
   * 真正需要类型安全的是路由声明处 requirePermission('person:read'),那在 interface 层。
   */
  readonly permissions: ReadonlySet<string>;
  /** 本次请求的追踪 id,写进日志与错误响应,用于把用户报障关联到服务端日志。 */
  readonly traceId: string;
}

/** 系统主体的 id。seed、定时任务、数据迁移这类无人值守的调用用它。 */
export const SYSTEM_ACTOR_ID = 'system';

/**
 * 系统主体。拥有全部权限、全部数据范围。
 *
 * [重要] 只能用于**确实没有人类发起者**的场景。
 * 绝不允许在 HTTP 请求路径上用它兜底 —— 那等于给所有接口开后门。
 */
export const systemActor = (traceId = 'system'): ActorContext => ({
  actorId: SYSTEM_ACTOR_ID,
  username: 'system',
  roleCodes: [],
  superAdmin: true,
  dataScope: 'ALL',
  permissions: new Set(),
  traceId,
});

/**
 * 权限判定。纯函数,零 IO,可单独测。
 *
 * 超管恒真的设计取代了通配符权限码(person:* / *):
 * 通配符会让"这个角色到底有什么权限"变成需要推理的问题,也让审计难做;
 * 布尔字段更显式,而且允许存在多个超管角色。
 * 另一个好处是新增业务模块时超管自动拥有新权限,不必回头给管理员角色补勾。
 */
export const hasPermission = (actor: ActorContext, code: string): boolean =>
  actor.superAdmin || actor.permissions.has(code);

/** 多角色合并的输入形状。 */
export interface RoleGrant {
  readonly code: string;
  readonly superAdmin: boolean;
  readonly dataScope: DataScope;
  readonly permissions: readonly string[];
}

/**
 * 把用户身上的多个角色合并成一份有效权限。
 *
 * 合并规则(全部取"最宽",因为角色是加法不是减法):
 * - permissions: 各角色的并集
 * - superAdmin:  任一为真则真
 * - dataScope:   取最宽(ALL > SELF)
 *
 * 为什么是纯函数: 这是整个鉴权体系里唯一有分支逻辑的地方,必须能脱离数据库单独测。
 */
export const mergeRoles = (
  roles: readonly RoleGrant[],
): Pick<ActorContext, 'roleCodes' | 'superAdmin' | 'dataScope' | 'permissions'> => {
  const permissions = new Set<string>();
  let superAdmin = false;
  let dataScope: DataScope = 'SELF';

  for (const role of roles) {
    if (role.superAdmin) superAdmin = true;
    if (role.dataScope === 'ALL') dataScope = 'ALL';
    for (const code of role.permissions) permissions.add(code);
  }

  return {
    roleCodes: roles.map((r) => r.code),
    superAdmin,
    // 没有任何角色时给最严格的 SELF。这条兜底很重要:
    // 一个"忘了分配角色"的用户应该什么都看不到,而不是看到全部。
    dataScope: roles.length === 0 ? 'SELF' : dataScope,
    permissions,
  };
};
