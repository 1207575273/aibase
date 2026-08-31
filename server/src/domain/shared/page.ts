/**
 * 分页的领域侧表示。
 *
 * 干什么: Repository 的列表方法一律收 PageParams、返回 Page<T>。
 * 解决什么问题: 姊妹项目的 Repository 全是 listAll() / listByPeriod() 这类
 *   无上限方法,全项目零处 skip/take,数据一多就是一次性拉全表 + 前端卡死。
 *
 * [硬约束] Repository 接口里**不允许**出现返回全量数组的列表方法。
 *   确实需要遍历全表的场景(导出、统计)另开专门的方法并写明为什么安全。
 *
 * 与契约里的 PageQuery/PageEnvelope 是有意分开的两套:
 *   契约那套描述"HTTP 上长什么样"(page 从 1 开始,因为对用户友好),
 *   这套描述"数据库要什么"(skip/take,因为 SQL 就是这么分页的)。
 *   转换在 Service 里做一次,domain 不需要知道"第几页"这个 UI 概念。
 */

export interface PageParams {
  /** 跳过多少条。由 (page - 1) * size 算出。 */
  skip: number;
  /** 取多少条。 */
  take: number;
}

export interface Page<T> {
  items: T[];
  /** 符合筛选条件的总数,不是本页条数。 */
  total: number;
}

/** 把「第几页 / 每页几条」翻译成「跳过多少 / 取多少」。 */
export const toPageParams = (page: number, size: number): PageParams => ({
  skip: (page - 1) * size,
  take: size,
});
