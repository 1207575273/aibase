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
import { canEncrypt, encryptPassword } from './encrypt-password';

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

/**
 * 登录。密码优先走加密通道,并在必要时自动重试。
 *
 * 两种降级情况:
 * 1. **拿不到 crypto.subtle** —— 浏览器只在安全上下文(https 或 localhost)
 *    暴露它。用局域网 IP 走 http 访问时就没有,此时退回明文通道。
 *    (真要在这种场景下也强制加密,得上 https;后端把
 *     AUTH_REQUIRE_ENCRYPTED_PASSWORD 设为 true 会直接拒绝明文,不会静默降级。)
 * 2. **服务端密钥已轮换 / nonce 过期** —— 后端重启会换密钥,
 *    此时自动重取挑战再试一次,而不是把"服务刚重启过"显示成"密码错误"。
 */
export const useLogin = () => {
  const queryClient = useQueryClient();

  const attempt = async (input: { username: string; password: string }): Promise<void> => {
    if (!canEncrypt()) {
      await authApi.login({ username: input.username, password: input.password });
      return;
    }
    const challenge = await authApi.loginChallenge();
    const passwordCipher = await encryptPassword(input.password, challenge);
    await authApi.login({ username: input.username, passwordCipher });
  };

  return useMutation({
    mutationFn: async (input: { username: string; password: string }) => {
      try {
        await attempt(input);
      } catch (e) {
        // 密钥/nonce 失效:重取挑战再试一次。只重试一次,避免死循环。
        if (isApiError(e) && e.code === 'AUTH_LOGIN_KEY_EXPIRED') {
          await attempt(input);
        } else {
          throw e;
        }
      }
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
    mutationFn: authApi.logout,
    onSuccess: () => {
      // 清空**全部**缓存而不只是 me —— 换个账号登录时,
      // 上一个账号的人员列表不能还留在缓存里
      queryClient.clear();
    },
  });
};

export type { MeResponse };
