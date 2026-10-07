/**
 * 密码哈希端口。
 *
 * 干什么: 抽象"把明文密码变成可存储的哈希"与"验证明文是否匹配"。
 * 解决什么问题: 让算法可替换。默认实现是 node:crypto 的 scrypt(零依赖),
 *   将来要换 argon2id 时只需新增一个实现文件,不动任何业务代码。
 */
export interface PasswordHasher {
  /** 返回 PHC 风格的完整哈希串(自带算法名与成本参数)。 */
  hash(plain: string): Promise<string>;

  /**
   * 验证明文是否匹配存储的哈希。
   *
   * needsRehash: 存储串用的是旧算法或低于当前成本参数。调用方可以在登录成功后
   * 用新参数重新 hash 并落库 —— 这就是"以后换算法不需要强制全员重置密码"的机制。
   */
  verify(plain: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }>;
}
