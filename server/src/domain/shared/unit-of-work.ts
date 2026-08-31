/**
 * 事务边界端口(Unit of Work)。
 *
 * 干什么: 让 application 层能显式声明「这几步要么全成功要么全回滚」,
 *         而不需要知道底层是 Prisma 的 $transaction 还是别的什么。
 *
 * 解决什么问题:
 *   姊妹项目 work_nm_tp 的 20 处 $transaction **全部**在 infrastructure 内部,
 *   application 层拿到的只是一个个独立的 repo 接口 —— 跨聚合写(先写 A 再写 B)
 *   根本无法原子化。为了绕开这一点,它把「删 Task 时顺带删 TaskNote、
 *   把 DayLog.taskId 置 null」这种**业务级联规则硬塞进了 PrismaTaskRepository.delete()**。
 *   后果是:
 *   - 业务规则漏进了基础设施层,读 Service 代码看不出会发生级联删除;
 *   - 换个持久化实现就得把这些规则重写一遍;
 *   - 它 README 里"事务边界在 application 层"这句话是假的。
 *
 * 用法:
 * ```ts
 * await this.deps.uow.run(async (repos) => {
 *   await repos.user.update(id, patch);
 *   await repos.session.deleteAllByUserId(id);   // 禁用用户就得踢掉他所有会话
 * });
 * ```
 * 回调里拿到的 repos 是**绑定在同一个事务上**的仓储实例。用外面那份(非事务的)
 * 就不在事务里 —— 所以回调里一律用参数给的 repos,不要用 this.deps.xxxRepo。
 *
 * [注意] SQLite 是单写者模型: 事务持有写锁期间其他写请求会等待(busy_timeout 5s)。
 *   所以事务里**不要**放网络调用、文件 IO 这类慢操作,只放数据库写。
 */

import type { RoleRepository } from '../auth/role.repository.js';
import type { SessionRepository } from '../auth/session.repository.js';
import type { UserRepository } from '../auth/user.repository.js';

/**
 * 事务内可用的全部仓储。
 *
 * 新增一个业务模块时在这里加一行 —— 加了之后所有 uow.run 回调自动就能用,
 * 不需要改 UnitOfWork 接口本身。
 */
export interface RepoBundle {
  user: UserRepository;
  role: RoleRepository;
  session: SessionRepository;
}

export interface UnitOfWork {
  /**
   * 在一个数据库事务里执行 fn。
   * fn 抛异常 -> 整个事务回滚,异常继续往上抛;正常返回 -> 提交并把返回值透传出来。
   */
  run<T>(fn: (repos: RepoBundle) => Promise<T>): Promise<T>;
}
