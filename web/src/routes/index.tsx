/**
 * 根路径 —— 直接重定向到默认业务页。
 *
 * 不做仪表盘首页: 那是产品功能不是模板骨架,而且每个业务的首页内容完全不同。
 */
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/users' });
  },
});
