/**
 * 认证相关接口。
 *
 * 请求体类型直接来自契约包 —— 后端改了字段,这里编译期就会报错。
 */
import type {
  ChangePasswordBody,
  LoginBody,
  LoginChallengeResponse,
  LoginResponse,
  MeResponse,
  OkResponse,
  PermissionCatalogResponse,
} from '@app/contracts';
import { api } from './http';

export const authApi = {
  /** 取登录挑战(公钥 + 一次性 nonce)。提交登录前先调这个。 */
  loginChallenge: (): Promise<LoginChallengeResponse> => api.get('/auth/login-challenge'),
  login: (body: LoginBody): Promise<LoginResponse> => api.post('/auth/login', body),
  logout: (): Promise<OkResponse> => api.post('/auth/logout'),
  me: (): Promise<MeResponse> => api.get('/auth/me'),
  changePassword: (body: ChangePasswordBody): Promise<OkResponse> =>
    api.post('/auth/change-password', body),
  permissionCatalog: (): Promise<PermissionCatalogResponse> => api.get('/auth/permission-catalog'),
};
