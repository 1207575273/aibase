/**
 * 用户 / 角色管理的数据 hooks。
 */

import type {
  CreateRoleBody,
  CreateUserBody,
  RoleListQuery,
  UpdateRoleBody,
  UpdateUserBody,
  UserListQuery,
} from '@app/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { roleApi, userApi } from '@/api/system';
import { authApi } from '@/api/auth';
import { isApiError } from '@/api/http';

export const userKeys = {
  all: ['users'] as const,
  list: (q: UserListQuery) => [...userKeys.all, 'list', q] as const,
};

const ROLE_ROOT = ['roles'] as const;

export const roleKeys = {
  all: ROLE_ROOT,
  list: (q: RoleListQuery) => [...ROLE_ROOT, 'list', q] as const,
  // 注意用 ROLE_ROOT 而不是 roleKeys.all —— 对象字面量里不能引用自身
  options: [...ROLE_ROOT, 'options'] as const,
  catalog: ['permission-catalog'] as const,
};

const toastError = (error: unknown, fallback: string): void => {
  toast.error(isApiError(error) ? error.message : fallback);
};

// ── 用户 ──────────────────────────────────────────────────────

export const useUserList = (query: UserListQuery) =>
  useQuery({
    queryKey: userKeys.list(query),
    queryFn: () => userApi.list(query),
    placeholderData: (prev) => prev,
  });

export const useCreateUser = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUserBody) => userApi.create(body),
    onSuccess: async () => {
      toast.success('用户已创建');
      await qc.invalidateQueries({ queryKey: userKeys.all });
    },
    onError: (e) => toastError(e, '创建失败'),
  });
};

export const useUpdateUser = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateUserBody }) => userApi.update(id, body),
    onSuccess: async () => {
      toast.success('用户已更新');
      await qc.invalidateQueries({ queryKey: userKeys.all });
    },
    onError: (e) => toastError(e, '更新失败'),
  });
};

export const useResetPassword = () =>
  useMutation({
    mutationFn: ({ id, newPassword }: { id: string; newPassword: string }) =>
      userApi.resetPassword(id, { newPassword }),
    onSuccess: () => toast.success('密码已重置,该用户的所有会话已失效'),
    onError: (e) => toastError(e, '重置失败'),
  });

export const useDeleteUser = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => userApi.remove(id),
    onSuccess: async () => {
      toast.success('用户已删除');
      await qc.invalidateQueries({ queryKey: userKeys.all });
    },
    onError: (e) => toastError(e, '删除失败'),
  });
};

// ── 角色 ──────────────────────────────────────────────────────

export const useRoleList = (query: RoleListQuery) =>
  useQuery({
    queryKey: roleKeys.list(query),
    queryFn: () => roleApi.list(query),
    placeholderData: (prev) => prev,
  });

/** 角色下拉选项。数据几乎不变,缓存久一点。 */
export const useRoleOptions = () =>
  useQuery({
    queryKey: roleKeys.options,
    queryFn: roleApi.options,
    staleTime: 5 * 60 * 1000,
  });

/**
 * 权限目录。它来自后端的代码常量,一次发版内绝不会变 ——
 * staleTime 设成 Infinity,整个会话只请求一次。
 */
export const usePermissionCatalog = () =>
  useQuery({
    queryKey: roleKeys.catalog,
    queryFn: authApi.permissionCatalog,
    staleTime: Infinity,
  });

export const useCreateRole = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRoleBody) => roleApi.create(body),
    onSuccess: async () => {
      toast.success('角色已创建');
      await qc.invalidateQueries({ queryKey: roleKeys.all });
    },
    onError: (e) => toastError(e, '创建失败'),
  });
};

export const useUpdateRole = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateRoleBody }) => roleApi.update(id, body),
    onSuccess: async () => {
      toast.success('角色已更新');
      // 角色变了,当前用户自己的权限也可能变 —— 一并刷新 /auth/me
      await qc.invalidateQueries({ queryKey: roleKeys.all });
      await qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    onError: (e) => toastError(e, '更新失败'),
  });
};

export const useDeleteRole = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => roleApi.remove(id),
    onSuccess: async () => {
      toast.success('角色已删除');
      await qc.invalidateQueries({ queryKey: roleKeys.all });
    },
    onError: (e) => toastError(e, '删除失败'),
  });
};
