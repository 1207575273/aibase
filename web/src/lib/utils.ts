/**
 * shadcn/ui 约定的 cn 工具 —— 合并 className。
 *
 * clsx 处理条件类名,tailwind-merge 解决冲突:
 * cn('p-2', 'p-4') 得到 'p-4' 而不是两个都留着(后者在 CSS 里谁赢取决于
 * 生成顺序,是个不确定行为)。
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
