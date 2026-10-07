/**
 * 展示层格式化 —— 全站统一从这里取,不要在页面里各写一份。
 *
 * 约定(见 CLAUDE.md「数据」):后端存 UTC、接口返回 ISO 字符串,展示一律按 Asia/Shanghai。
 * 只用浏览器内置的 Intl,不引 dayjs / date-fns —— 展示格式化用不到它们的计算能力。
 *
 * 空值(null / undefined / 非法日期)统一显示 '-',列表里不出现 "Invalid Date"。
 */

const TIME_ZONE = 'Asia/Shanghai';
const EMPTY = '-';

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const numberFormatter = new Intl.NumberFormat('zh-CN');

const toDate = (value: string | Date | null | undefined): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** 按 formatToParts 拼成固定形状,不依赖各浏览器 zh-CN 的分隔符差异("/" 还是 "-")。 */
const join = (formatter: Intl.DateTimeFormat, date: Date, withTime: boolean): string => {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  const day = `${parts['year']}-${parts['month']}-${parts['day']}`;
  return withTime ? `${day} ${parts['hour']}:${parts['minute']}` : day;
};

/** 2026-10-07 17:30 */
export const formatDateTime = (value: string | Date | null | undefined): string => {
  const date = toDate(value);
  return date === null ? EMPTY : join(dateTimeFormatter, date, true);
};

/** 2026-10-07 */
export const formatDate = (value: string | Date | null | undefined): string => {
  const date = toDate(value);
  return date === null ? EMPTY : join(dateFormatter, date, false);
};

/** 1,234,567 */
export const formatNumber = (value: number | null | undefined): string =>
  value === null || value === undefined || Number.isNaN(value) ? EMPTY : numberFormatter.format(value);
