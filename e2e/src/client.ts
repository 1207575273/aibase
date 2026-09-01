/**
 * e2e 用的极简 HTTP 客户端。
 *
 * 刻意不复用前端的 axios 封装: e2e 要验的是**接口本身**,
 * 用一个薄到能一眼看完的 fetch 包装,避免客户端库的行为
 * (拦截器、自动重试、错误转换)干扰对服务端行为的判断。
 */

import { BASE_URL } from './global-setup.js';

export interface ApiResult<T> {
  status: number;
  body: T;
  headers: Headers;
}

export interface RequestOptions {
  token?: string | undefined;
  /**
   * 原样发送的 Cookie 头。
   *
   * 登录态**不走 Cookie**,保留这个口子是为了能写"就算带了 Cookie 也不该被当成
   * 凭证"这类反向断言 —— 哪天有人把 Cookie 认证加回来,测试要能发现。
   */
  cookie?: string | undefined;
  headers?: Record<string, string> | undefined;
}

const request = async <T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<ApiResult<T>> => {
  const headers: Record<string, string> = { ...options.headers };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token !== undefined) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.cookie !== undefined) headers['Cookie'] = options.cookie;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    // 非 JSON 响应原样保留,便于断言"这里不该返回 HTML"这类问题
  }

  return { status: res.status, body: parsed as T, headers: res.headers };
};

export const api = {
  get: <T>(path: string, options?: RequestOptions): Promise<ApiResult<T>> =>
    request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResult<T>> =>
    request<T>('POST', path, body, options),
};

/**
 * 登录并返回 token,以及响应里的 Set-Cookie 原值。
 * 后者正常应当是 null —— auth.e2e.ts 有一条用例专门断言它,防止 Cookie 认证被加回来。
 */
export const login = async (
  username: string,
  password: string,
): Promise<{ token: string; setCookie: string | null }> => {
  const res = await api.post<{ token: string }>('/auth/login', { username, password });
  if (res.status !== 200) {
    throw new Error(`登录失败(${res.status}): ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.token, setCookie: res.headers.get('set-cookie') };
};
