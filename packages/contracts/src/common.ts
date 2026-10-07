/**
 * 契约内核 —— 所有域契约共用的基础类型与信封。
 *
 * 干什么: 定义 wire 层的通用约定(时间表示、分页信封、错误体、空响应)。
 * 解决什么问题: 这些约定最容易变成"只存在于注释和口头默契里"的东西 ——
 *   列表返回 { items, total } 还是裸数组、写操作返 200 还是 204,
 *   一旦每个路由各自内联字面量,前后端就会开始漂移且没人发现。收进这里由编译器统一保证。
 *
 * wire 层三条硬约定(全包适用,新增域契约必须遵守):
 * 1. 时间一律 IsoDateString(ISO 8601 字符串),线上不出现 Date 对象。
 *    后端 domain 里的 Date 由 interface 层的 toWire 转换,领域形状不泄漏到线上。
 * 2. id 一律裸 string。
 * 3. 只描述「线上真实传输的形状」,不描述领域模型。两者不一致时以真实 HTTP 响应为准 ——
 *    契约不是 domain 的复制品,domain 要能自由改字段而不惊动前端。
 */

import { z } from 'zod';

/**
 * ISO 8601 时间字符串,如 `2026-08-27T03:01:59.889Z`。
 *
 * 运行时就是 string,别名只为在类型上标记语义。前端一律用 dayjs 解析,
 * 不要 `new Date(x)` 再手工格式化。
 */
export type IsoDateString = string;

// ── 分页 ──────────────────────────────────────────────────────────
//
// [硬约束] 任何列表端点都必须分页,不得无上限返回全表。
// 缺了这条的话,结果全项目零处 page/size,ListEnvelope.total
// 一律等于 items.length —— 是个会主动误导消费方"以为有分页"的假信封。

/** 单页最大条数。防御性上限:客户端传 size=99999 时截断而不是拖垮数据库。 */
export const PAGE_SIZE_MAX = 100;
export const PAGE_SIZE_DEFAULT = 20;

/**
 * 分页查询参数。用于 GET 的 query string,所以必须 coerce ——
 * query 里拿到的永远是字符串,`?page=2` 的 2 是 '2' 不是 2。
 */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

/**
 * 分页请求的客户端视角类型。
 *
 * 用 z.input 而不是 z.infer(等价于 output):带 `.default()` 的字段在 output 侧
 * 是必填(默认值已填好),用它会让「客户端能发什么」这一面把可选字段误判成必填,
 * 合法调用被编译期拦掉。契约描述的是请求方能发的形状,所以只能取 input。
 */
export type PageQuery = z.input<typeof PageQuerySchema>;

/** 分页响应信封。total 是符合筛选条件的总数,不是本页条数。 */
export interface PageEnvelope<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/**
 * 不分页的列表信封 —— 只用于「业务上就是有限且很小」的集合,
 * 比如角色列表、权限目录。用它等于向消费方承诺「这里不会长到需要翻页」。
 */
export interface ItemsEnvelope<T> {
  items: T[];
}

// ── 通用响应 ──────────────────────────────────────────────────────

/** 无返回值的写操作统一响应。不混用 204 空体 —— 前端少一个分支。 */
export interface OkResponse {
  ok: true;
}

/** 创建类端点的统一响应。 */
export interface CreatedIdResponse {
  id: string;
}

/**
 * HTTP 错误响应体。全站唯一形状,由后端 server/src/platform/http/handle-error.ts 产生。
 *
 * traceId: 每个响应都会带,与服务端日志里的同名字段一一对应。
 *   用户报障时把它读出来,就能直接定位到那一次请求的完整日志。
 *   (曾见过的一个项目声明了这个字段但从未填过,等于没有 —— 本模板由中间件强制填充。)
 */
export interface ErrorResponse {
  code: string;
  message: string;
  details?: unknown;
  traceId: string;
}

// ── 审计字段 ──────────────────────────────────────────────────────

/**
 * 所有业务实体在 wire 上都带的审计字段。
 *
 * [硬约束] 每张业务表都必须有这四个字段。曾见过的一个项目里,38 张表没有一张有 createdBy,
 * 导致后来想加权限时发现「谁创建的」这条信息根本不存在,只能改 schema 重来。
 * 宁可一开始就带上。
 */
export interface AuditWire {
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  /** 创建者 userId。系统内建数据(如 seed 的管理员)为 null。 */
  createdBy: string | null;
  updatedBy: string | null;
}
