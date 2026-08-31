/**
 * 表单公共助手。
 */

import { toast } from 'sonner';
import type { FieldErrors, FieldValues } from 'react-hook-form';

/**
 * 校验失败时的兜底提示 —— 传给 `form.handleSubmit(onValid, onInvalid)` 的第二个参数。
 *
 * ── 为什么必须有 ──────────────────────────────────────────────
 *
 * react-hook-form 在校验不通过时**不调用 onSubmit,也不给任何反馈**。
 * 正常情况下错误会显示在对应输入框下面,用户看得见;
 * 但如果错误挂在**根路径**(path 为空),就没有任何输入框能承载它 ——
 * 页面上一片安静,用户看到的是「点保存没反应」。
 *
 * 根路径错误的典型来源:拿 `z.strictObject` 的请求体 schema 当表单 resolver,
 * 表单里的多余字段被判成 `unrecognized_keys`,issue 的 path 是 `[]`。
 * (这个 bug 在用户编辑表单上真实发生过,排查成本很高。)
 *
 * 有了它,任何"提交了但没成功"的情况都至少会响一声,
 * 不会再出现「按钮点了像没点」这种最难受的失败模式。
 */
export const onFormInvalid = <T extends FieldValues>(errors: FieldErrors<T>): void => {
  const fields = Object.keys(errors);
  // 没有字段级错误,或者只有根级错误 —— 说明界面上看不到任何提示,必须弹出来
  const invisible = fields.length === 0 || fields.every((f) => f === 'root');

  toast.error(invisible ? '表单校验未通过,请检查填写内容' : '请修正标红的字段后再保存');

  if (invisible && import.meta.env.DEV) {
    // 开发态把原始错误打出来 —— 这类问题往往是 schema 用错了,
    // 光看提示定位不到,得看到 unrecognized_keys 才明白
    console.warn('[form] 校验失败但无字段级错误,可能是 schema 用错了:', errors);
  }
};
