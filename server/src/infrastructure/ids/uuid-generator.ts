/**
 * ID 生成器实现 —— UUID v7。
 *
 * v7 而不是 v4: 高 48 位是毫秒时间戳,所以字典序≈时间序。
 * 对 B-tree 索引意味着插入总在树的右端,不会像 v4 那样把页分裂散布到整棵树;
 * 同时"按 id 排序"天然就是"按创建时间排序",省一个索引。
 */

import { v7 as uuidv7 } from 'uuid';
import type { IdGenerator } from '../../domain/shared/id-generator.js';

export const uuidGenerator: IdGenerator = {
  next: (): string => uuidv7(),
};
