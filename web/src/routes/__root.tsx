/**
 * 根路由 —— 所有页面的外壳。
 *
 * 这里挂了三样全局的东西:
 *   1. Toaster(全局提示)
 *   2. errorComponent(渲染期异常兜底)
 *   3. notFoundComponent(404 页)
 *
 * 后两个是曾见过的一个项目完全缺失的 —— 它全仓 grep 不到 errorComponent /
 * ErrorBoundary,任何一个组件抛错就是**整页白屏**,用户只看到空白,
 * 控制台的报错也不会有人去看。
 */

import { QueryClient } from '@tanstack/react-query';
import { Link, Outlet, createRootRouteWithContext } from '@tanstack/react-router';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  errorComponent: ErrorComponent,
  notFoundComponent: NotFoundComponent,
});

function RootComponent(): React.JSX.Element {
  return (
    <>
      <Outlet />
      <Toaster richColors closeButton />
    </>
  );
}

/**
 * 渲染期异常兜底。
 *
 * 关键是**把错误信息显示出来**而不是一片空白 —— 用户能截图,
 * 开发能一眼看到是什么错,不用去问"你当时点了什么"。
 */
function ErrorComponent({ error }: { error: Error }): React.JSX.Element {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">页面出错了</h1>
      <p className="max-w-xl text-center text-sm text-muted-foreground">{error.message}</p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => window.location.reload()}>
          刷新页面
        </Button>
        <Button asChild>
          <Link to="/">返回首页</Link>
        </Button>
      </div>
    </div>
  );
}

function NotFoundComponent(): React.JSX.Element {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold text-muted-foreground">404</h1>
      <p className="text-muted-foreground">页面不存在</p>
      <Button asChild>
        <Link to="/">返回首页</Link>
      </Button>
    </div>
  );
}
