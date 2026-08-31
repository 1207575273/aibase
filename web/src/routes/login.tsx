/**
 * 登录页。
 *
 * 示范了表单的标准做法: react-hook-form + zodResolver + **复用契约包的 schema**。
 * 复用同一份 schema 意味着前端的表单校验规则与后端的 400 判定**完全一致** ——
 * 不会出现"前端放过了但后端拒了"这种让用户困惑的情况。
 */

import { LoginFormSchema, type LoginForm } from '@app/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { isApiError } from '@/api/http';
import { onFormInvalid } from '@/lib/form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLogin } from '@/features/auth/use-auth';

/** 登录后要跳回的地址。被 401 拦截时由 http 拦截器带上。 */
const SearchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute('/login')({
  validateSearch: SearchSchema,
  component: LoginPage,
});

function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const login = useLogin();

  const form = useForm<LoginForm>({
    resolver: zodResolver(LoginFormSchema),
    defaultValues: { username: '', password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await login.mutateAsync(values);
      await navigate({ to: redirect ?? '/users' });
    } catch (e) {
      // 把后端的错误落到表单上,而不是弹个 toast 就完了 ——
      // 用户的注意力在表单里,错误就该显示在那里
      form.setError('password', {
        message: isApiError(e) ? e.message : '登录失败,请稍后重试',
      });
    }
  }, onFormInvalid);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">登录</CardTitle>
          <CardDescription>请输入账号密码进入系统</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="username">用户名</Label>
              <Input
                id="username"
                autoComplete="username"
                autoFocus
                {...form.register('username')}
              />
              {form.formState.errors.username !== undefined && (
                <p className="text-sm text-destructive">
                  {form.formState.errors.username.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...form.register('password')}
              />
              {form.formState.errors.password !== undefined && (
                <p className="text-sm text-destructive">
                  {form.formState.errors.password.message}
                </p>
              )}
            </div>

            <Button type="submit" className="w-full" disabled={login.isPending}>
              {login.isPending ? '登录中...' : '登录'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
