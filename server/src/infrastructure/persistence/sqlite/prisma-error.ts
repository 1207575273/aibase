/**
 * Prisma 错误 -> AppError 翻译。
 *
 * 干什么: 把 Prisma 的错误码翻译成带正确 HTTP 状态的业务错误。
 * 解决什么问题:
 *   姊妹项目**全仓零处** P2002 / PrismaClientKnownRequestError 处理 ——
 *   邮箱重复这种最常见的用户错误会以裸 Prisma 异常穿透到最外层,变成 500
 *   「服务内部错误」。用户看到的是"系统崩了",实际只是"这个邮箱有人用了"。
 *
 * 配套的纪律(写进 CLAUDE.md):
 *   **唯一性一律靠数据库约束 + 这里的翻译,禁止在 Service 里 check-then-act。**
 *   "先 findByEmail 再 create"在并发下必然出竞态:两个请求同时查到不存在,
 *   然后都去写。数据库唯一约束是唯一可靠的并发安全点。
 */

import { conflict, notFound, type AppError } from '../../../domain/shared/app-error.js';
import { Prisma } from './prisma.js';

const isKnownError = (e: unknown): e is Prisma.PrismaClientKnownRequestError =>
  e instanceof Prisma.PrismaClientKnownRequestError;

/**
 * 从 P2002 的 meta 里取出撞车的字段名,用于生成"该邮箱已被使用"这类具体提示。
 *
 * [坑] 字段名的位置在 Prisma 7 的 driver adapter 下**变了**:
 *   - v6(Rust engine):    meta.target = ['email']
 *   - v7(driver adapter): meta.driverAdapterError.cause.constraint.fields = ['email']
 *   实测确认。两种都读,升级降级都不会静默失效 —— 读不到字段名的后果是
 *   409 的 code 退化成通用的 UNIQUE_VIOLATION,前端就没法针对"邮箱重复"
 *   做字段级提示了,而且这种退化不会报错,只会悄悄变难用。
 */
const targetFields = (e: Prisma.PrismaClientKnownRequestError): string[] => {
  const meta = e.meta as
    | {
        target?: unknown;
        driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } };
      }
    | undefined;

  // v7 driver adapter 形状
  const adapterFields = meta?.driverAdapterError?.cause?.constraint?.fields;
  if (Array.isArray(adapterFields)) {
    return adapterFields.filter((f): f is string => typeof f === 'string');
  }

  // v6 / 其他 provider 形状
  const target = meta?.target;
  if (Array.isArray(target)) return target.filter((t): t is string => typeof t === 'string');
  if (typeof target === 'string') return [target];
  return [];
};

export interface PrismaErrorMapping {
  /**
   * 唯一约束冲突(P2002)。key 是字段名,值是要抛的错误。
   * 例: { email: () => conflict(PERSON_ERROR.EMAIL_TAKEN, '该邮箱已被使用') }
   */
  unique?: Record<string, () => AppError>;
  /** 记录不存在(P2025)。update/delete 一个已被删掉的 id 时触发。 */
  notFound?: () => AppError;
}

/**
 * 包一层 Prisma 调用,把已知错误翻译成 AppError,其余原样抛出。
 *
 * @example
 * await mapPrismaError(
 *   () => prisma.user.create({ data }),
 *   { unique: { username: () => conflict('USERNAME_TAKEN', '该用户名已被占用') } },
 * );
 */
export const mapPrismaError = async <T>(
  run: () => Promise<T>,
  mapping: PrismaErrorMapping = {},
): Promise<T> => {
  try {
    return await run();
  } catch (e) {
    if (!isKnownError(e)) throw e;

    if (e.code === 'P2002') {
      const fields = targetFields(e);
      for (const field of fields) {
        const factory = mapping.unique?.[field];
        if (factory !== undefined) throw factory();
      }
      // 没登记具体字段时给一个通用的 409,而不是让它变成 500。
      // details 里带上字段名,便于排查是哪个约束撞了。
      throw conflict('UNIQUE_VIOLATION', '数据已存在,请检查唯一字段', { fields });
    }

    if (e.code === 'P2025') {
      throw mapping.notFound?.() ?? notFound('NOT_FOUND', '记录不存在或已被删除');
    }

    if (e.code === 'P2003') {
      // 外键约束失败。两种情况:引用了不存在的父记录,或删除了仍被引用的记录。
      throw conflict('FK_VIOLATION', '存在关联数据,操作被拒绝', {
        field: e.meta?.['field_name'],
      });
    }

    throw e;
  }
};
