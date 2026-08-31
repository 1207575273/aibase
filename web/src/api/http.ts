/**
 * HTTP 客户端 —— 全前端唯一 import axios 的地方(eslint R5 守着)。
 *
 * 干什么: 单实例 + 拦截器,统一处理 baseURL、Cookie 携带、错误归一化、401 跳登录。
 *
 * 解决什么问题:
 * - 业务代码里零 `.then(r => r.data)`、零 AxiosResponse 泄漏 —— 换 HTTP 库只改这一个文件。
 * - **错误形状统一**: 后端错误、网络错误、超时,在业务层看到的都是同一个
 *   ApiError 形状。不统一的话,有的地方展示后端的中文 message、
 *   有的地方展示 axios 的 "Request failed with status code 500"。
 */

import type { ErrorResponse } from '@app/contracts';
import axios, { AxiosError } from 'axios';
import { tokenStore } from './token-store.js';

/**
 * 归一化后的接口错误。业务层只认这一个类型。
 *
 * traceId 是关键: 展示给用户时带上它,用户报障时报这一串,
 * 后端 grep 日志就能拿到那次请求的完整记录。
 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly traceId: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 字段级校验错误。表单可以直接拿它标红对应输入框。 */
  get fieldErrors(): Array<{ field: string; message: string }> {
    const d = this.details as { fields?: Array<{ field: string; message: string }> } | undefined;
    return d?.fields ?? [];
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

/**
 * 未登录时的回调。由 App 层注入 —— 这里不直接操作路由,
 * 免得 api 层依赖路由库(那会让它没法在非组件环境里用)。
 */
let onUnauthenticated: (() => void) | undefined;
export const setUnauthenticatedHandler = (handler: () => void): void => {
  onUnauthenticated = handler;
};

/**
 * API 基地址。
 *
 * `import.meta.env.BASE_URL` 是 vite 从 ports.json 的 contextPath 算出来的
 * (见 vite.config.ts 的 base),形态固定是 '/' 或 '/app/' —— 带尾斜杠。
 * 拼上 'api' 就得到 '/api' 或 '/app/api',与后端的 config.apiPrefix 一致。
 *
 * 这样前端代码里**不出现任何硬编码前缀**:启用 contextPath 时改 ports.json 一处,
 * 打包产物路径、路由前缀、API 地址三者自动对齐。
 */
const API_BASE = `${import.meta.env.BASE_URL}api`;

export const http = axios.create({
  // 开发态由 vite proxy 转发到后端,生产态是同源 —— 两种形态下路径相同
  baseURL: API_BASE,
  timeout: 30_000,
  // 不带 Cookie —— 凭证走 Authorization 头,见下方请求拦截器与 token-store.ts
  withCredentials: false,
});

/*
 * 请求拦截器:把令牌放进 Authorization 头。
 *
 * 这是整个应用唯一携带凭证的地方。因为是显式携带而非浏览器自动带,
 * 跨站页面伪造的请求不会有这个头 —— CSRF 天然不成立,后端也就不需要 origin 白名单。
 */
http.interceptors.request.use((cfg) => {
  const token = tokenStore.get();
  if (token !== null && token !== '') {
    cfg.headers.set('Authorization', `Bearer ${token}`);
  }
  return cfg;
});

http.interceptors.response.use(
  // 直接拆出 data —— 业务层不需要知道 AxiosResponse 的存在。
  // [注意] axios 的类型签名要求拦截器返回 AxiosResponse,但拆包正是这一层的意义。
  // 这个断言是**有意的**,配合下面 api.get/post 的返回类型标注,
  // 业务层拿到的类型仍然是准确的。
  (response) => response.data as unknown as typeof response,

  (error: unknown) => {
    if (!(error instanceof AxiosError)) {
      return Promise.reject(
        new ApiError('UNKNOWN', error instanceof Error ? error.message : '未知错误', 0, ''),
      );
    }

    // 网络层错误:后端没响应(断网、服务没起来、超时)
    if (error.response === undefined) {
      const isTimeout = error.code === 'ECONNABORTED';
      return Promise.reject(
        new ApiError(
          isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
          isTimeout ? '请求超时,请稍后重试' : '网络连接失败,请检查网络后重试',
          0,
          '',
        ),
      );
    }

    const { status, data } = error.response;
    const body = data as Partial<ErrorResponse> | undefined;

    const apiError = new ApiError(
      body?.code ?? 'UNKNOWN',
      body?.message ?? `请求失败(${status})`,
      status,
      body?.traceId ?? '',
      body?.details,
    );

    // 401 统一跳登录。403 不跳 —— 已登录但没权限的用户被跳去登录页,
    // 会陷入"登录成功 -> 还是没权限 -> 又被跳走"的死循环。
    if (status === 401) onUnauthenticated?.();

    return Promise.reject(apiError);
  },
);

/** 类型化的 GET / POST。项目只用这两个方法(后端 HTTP 约定)。 */
export const api = {
  get: <T>(url: string, params?: Record<string, unknown>): Promise<T> =>
    http.get(url, { params }) as unknown as Promise<T>,
  post: <T>(url: string, body?: unknown): Promise<T> =>
    http.post(url, body) as unknown as Promise<T>,
};
