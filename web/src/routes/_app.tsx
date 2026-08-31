/**
 * 受保护布局 —— 所有需要登录的页面都放在这个布局路由下。
 *
 * 文件名以 `_` 开头是 TanStack Router 的约定: 它是**布局路由**,
 * 不产生 URL 片段。所以 `_app/persons.tsx` 的地址是 `/persons` 而不是 `/app/persons`。
 *
 * 这是前端侧的「默认拒绝」: 页面文件放进 `_app/` 目录就自动受保护,
 * 不需要每个页面自己记得写鉴权判断。
 * (真正的安全边界仍然在后端 —— 前端这层只是免得未登录用户看到一个空壳页面。)
 */

import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { authApi } from '@/api/auth';
import { isApiError } from '@/api/http';
import { authKeys } from '@/features/auth/use-auth';
import { AppShell } from '@/components/layout/app-shell';

export const Route = createFileRoute('/_app')({
  /**
   * 进入任何受保护页面前先确认登录态。
   *
   * 用 ensureQueryData 而不是 fetchQuery: 已有缓存就直接用,
   * 不会每次切页面都打一次 /auth/me。
   */
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData({
        queryKey: authKeys.me,
        queryFn: authApi.me,
      });
    } catch (e) {
      if (isApiError(e) && (e.status === 401 || e.status === 403)) {
        // 带上当前地址,登录后跳回来 —— 用户点了一个深链接被要求登录,
        // 登录完应该回到他本来要去的地方
        throw redirect({ to: '/login', search: { redirect: location.href } });
      }
      throw e;
    }
  },
  component: AppLayout,
});

function AppLayout(): React.JSX.Element {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
