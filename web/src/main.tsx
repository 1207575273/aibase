/**
 * 前端入口。
 *
 * 做三件事: 建 QueryClient -> 建 Router -> 挂载。
 * 业务代码一行都不该出现在这里。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isApiError, setUnauthenticatedHandler } from '@/api/http';
import { routeTree } from './routeTree.gen';
import './styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 401/403 是"你没权限"不是"网络抖了",重试没有任何意义,
      // 只会让用户多等两秒才看到登录页
      retry: (failureCount, error) => {
        if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
      // 切回标签页就重新拉数据,对管理后台是合适的默认值
      refetchOnWindowFocus: true,
      staleTime: 30_000,
    },
    mutations: {
      // 写操作不重试 —— 重试一个"创建"可能造成重复数据
      retry: false,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  // 路由跳转时保留上一页内容直到新页面就绪,避免白屏闪烁
  defaultPendingMs: 300,
  /**
   * 路由基路径。来自 vite 的 base(最终源头是 ports.json 的 contextPath)。
   *
   * 没有它的话,启用 contextPath 后路由会按 /persons 匹配,
   * 而浏览器地址是 /app/persons —— 表现为"页面一进去就是 404",
   * 但 API 却是通的,很难联想到是路由前缀的问题。
   *
   * TanStack Router 要求 basepath 不带尾斜杠,所以这里把 BASE_URL 的尾斜杠去掉。
   */
  basepath: import.meta.env.BASE_URL.replace(/\/$/, ''),
});

// 让 TanStack Router 的类型系统认识我们的 router 实例,
// 于是 <Link to="..."> 的路径会有自动补全和类型检查
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// 401 时跳登录页。在这里接线而不是在 http.ts 里直接 import router ——
// 那样 api 层就依赖了路由库,没法在非组件环境(比如测试)里单独用。
setUnauthenticatedHandler(() => {
  // 用 router 的当前位置而不是 window.location.pathname:
  // 后者含 contextPath 前缀(/app/login),与路由内部的路径(/login)对不上,
  // 判断会永远不成立,导致在登录页收到 401 时反复自我跳转。
  const current = router.state.location.pathname;
  if (current !== '/login') {
    void router.navigate({ to: '/login', search: { redirect: current } });
  }
});

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('找不到 #root 挂载点');

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
