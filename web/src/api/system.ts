/**
 * 用户 / 角色管理接口。
 */
import type {
  CreateRoleBody,
  CreateUserBody,
  CreatedIdResponse,
  ItemsEnvelope,
  OkResponse,
  ResetPasswordBody,
  RoleListQuery,
  RoleListResponse,
  RoleWire,
  UpdateRoleBody,
  UpdateUserBody,
  UserListQuery,
  UserListResponse,
  UserWire,
} from '@app/contracts';
import { api } from './http';

export interface RoleOption {
  id: string;
  code: string;
  name: string;
}

export const userApi = {
  list: (query: UserListQuery): Promise<UserListResponse> =>
    api.get('/users', query as Record<string, unknown>),
  get: (id: string): Promise<UserWire> => api.get(`/users/${id}`),
  create: (body: CreateUserBody): Promise<CreatedIdResponse> => api.post('/users/create', body),
  update: (id: string, body: UpdateUserBody): Promise<OkResponse> =>
    api.post(`/users/${id}/update`, body),
  resetPassword: (id: string, body: ResetPasswordBody): Promise<OkResponse> =>
    api.post(`/users/${id}/reset-password`, body),
  remove: (id: string): Promise<OkResponse> => api.post(`/users/${id}/delete`),
};

export const roleApi = {
  list: (query: RoleListQuery): Promise<RoleListResponse> =>
    api.get('/roles', query as Record<string, unknown>),
  options: (): Promise<ItemsEnvelope<RoleOption>> => api.get('/roles/options'),
  get: (id: string): Promise<RoleWire> => api.get(`/roles/${id}`),
  create: (body: CreateRoleBody): Promise<CreatedIdResponse> => api.post('/roles/create', body),
  update: (id: string, body: UpdateRoleBody): Promise<OkResponse> =>
    api.post(`/roles/${id}/update`, body),
  remove: (id: string): Promise<OkResponse> => api.post(`/roles/${id}/delete`),
};
