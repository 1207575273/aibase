/**
 * 剔除 undefined 字段。
 *
 * 干什么: 把 patch 对象里值为 undefined 的键删掉,只留下真正要更新的字段。
 *
 * 解决什么问题:
 *   姊妹项目的每个 Repository.update 都手写着一长串
 *   `if (patch.title !== undefined) data.title = patch.title;`
 *   —— Task 有 12 个这样的分支,纯噪音。更糟的是它与 domain 的类型定义重复了一遍:
 *   加字段忘了在这里补一行,症状是"改了不保存",属于最难查的静默 bug。
 *
 * [关键] 必须保留 undefined 与 null 的语义区分:
 *   - undefined = 这个字段不改
 *   - null      = 把这个字段置空
 *   所以这里只删 undefined,null 要原样传给 Prisma。
 *   用 JSON.parse(JSON.stringify()) 之类的写法会把两者一起弄丢。
 */
export const stripUndefined = <T extends Record<string, unknown>>(patch: T): Partial<T> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
};
