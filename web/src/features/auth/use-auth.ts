/**
 * 认证状态与权限判断。
 *
 * 干什么: 用 TanStack Query 缓存 /auth/me,派生出 can() 权限判断函数。
 *
 * 为什么不用 zustand 之类的全局 store 存用户信息:
 *   用户信息是**服务端状态**不是客户端状态 —— 它有失效、有重新拉取、有加载中,
 *   这些正是 Query 擅长的。放进 store 就要自己写同步逻辑,
 *   还会出现"改了权限但 store 里还是旧的"。
 */

import type { MeResponse } from '@app/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { authApi } from '@/api/auth';
import { isApiError } from '@/api/http';
import { tokenStore } from '@/api/token-store';

/** queryKey 集中定义,避免"这里写 ['me'] 那里写 ['auth','me']"导致缓存对不上。 */
export const authKeys = {
  me: ['auth', 'me'] as const,
};

export const useMe = () =>
  useQuery({
    queryKey: authKeys.me,
    queryFn: authApi.me,
    // 未登录时 /auth/me 返回 401,这是**预期结果**不是错误,不该重试。
    // 不设的话每次进入登录页都会白白发三次请求。
    retry: (failureCount, error) => {
      if (isApiError(error) && (error.status === 401 || error.status === 403)) return false;
      return failureCount < 2;
    },
    // 用户信息不常变,5 分钟内不重复请求
    staleTime: 5 * 60 * 1000,
  });

/**
 * 权限判断。
 *
 * [重要] 前端权限**只控制显隐,不是安全边界**。
 * 真正的裁决在后端的 requirePermission 中间件。
 * 任何"前端藏了按钮所以后端不用校验"的做法直接判为 bug ——
 * 藏起来的按钮用 curl 一样能调。
 */
export const usePermission = (): ((code: string) => boolean) => {
  const { data } = useMe();

  return useCallback(
    (code: string): boolean => {
      if (data === undefined) return false;
      // 超管恒真,与后端 hasPermission 的判定保持一致
      return data.superAdmin || data.permissions.includes(code);
    },
    [data],
  );
};

/** 登录。密码明文提交,传输安全由 HTTPS 负责。 */
export const useLogin = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { username: string; password: string }) => {
      const result = await authApi.login(input);

      // 令牌落盘。必须在 invalidate 之前 —— 否则紧接着的 /auth/me 还没有凭证可带,
      // 会立刻 401,表现为"登录成功了却马上被踢回登录页"。
      tokenStore.save(result.token, result.expiresAt);
    },
    onSuccess: async () => {
      // 登录成功后必须重新拉 /auth/me —— 权限信息全靠它
      await queryClient.invalidateQueries({ queryKey: authKeys.me });
    },
  });
};

export const useLogout = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      // 先告知服务端(目前它无事可做,保留调用点),失败也不能挡住本地登出 ——
      // 令牌已经不想要了,网络问题不该让用户卡在登录态里出不去。
      try {
        await authApi.logout();
      } catch {
        // 忽略
      }
      // 真正的登出:把本地令牌删掉。JWT 是自验证的,服务端没有可吊销的东西。
      tokenStore.clear();
    },
    onSuccess: () => {
      // 清空**全部**缓存而不只是 me —— 换个账号登录时,
      // 上一个账号的人员列表不能还留在缓存里
      queryClient.clear();
    },
  });
};

export type { MeResponse };
