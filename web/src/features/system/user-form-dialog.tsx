/**
 * 用户表单弹窗。
 *
 * 新增与编辑的差别比人员大: 新增要填密码和用户名,编辑时这两项都不能改
 * (用户名是审计日志里的主体标识,改了历史日志就对不上人;
 *  改密码走独立的"重置密码"入口,因为它有额外的副作用 —— 踢掉全部会话)。
 * 两种模式共用一个组件外壳,只换校验规则。
 *
 * [关键] 校验用的是**表单 schema**(UserFormSchema / CreateUserFormSchema),
 * 不是请求体 schema。理由见 packages/contracts/src/user.ts 里 UserFormSchema 的注释 ——
 * 混用会导致「点保存没反应且没有任何提示」。
 */

import {
  CreateUserFormSchema,
  UserFormSchema,
  USER_STATUSES,
  USER_STATUS_LABELS,
  type UserFormValues,
  type UserWire,
} from '@app/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { isApiError } from '@/api/http';
import { onFormInvalid } from '@/lib/form';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useCreateUser, useRoleOptions, useUpdateUser } from './use-system';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserWire | null;
}

const EMPTY: UserFormValues = {
  username: '',
  displayName: '',
  password: '',
  status: 'ACTIVE',
  roleIds: [],
};

export const UserFormDialog = ({ open, onOpenChange, user }: Props): React.JSX.Element => {
  const isEdit = user !== null;
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const { data: roleOptions } = useRoleOptions();

  const form = useForm<UserFormValues>({
    /**
     * [重要] 这里用的是**表单 schema**,不是请求体 schema。
     *
     * 请求体 schema 是 strictObject,而表单始终持有全部五个字段 ——
     * 拿它当 resolver 会把 username/password/status 判成"未知的键",
     * 校验直接失败,而且错误挂在根路径落不到输入框上,
     * 表现就是「点保存没反应」且页面毫无提示。
     * 提交时再由下面的 onSubmit 从表单值里挑出该发的字段。
     */
    resolver: zodResolver(isEdit ? UserFormSchema : CreateUserFormSchema),
    defaultValues: EMPTY,
  });

  useEffect(() => {
    if (!open) return;
    form.reset(
      user === null
        ? { username: '', displayName: '', password: '', status: 'ACTIVE', roleIds: [] }
        : {
            username: user.username,
            displayName: user.displayName,
            password: '',
            status: user.status,
            roleIds: user.roles.map((r) => r.id),
          },
    );
  }, [open, user, form]);

  const selectedRoles = form.watch('roleIds') ?? [];

  const toggleRole = (roleId: string): void => {
    const next = selectedRoles.includes(roleId)
      ? selectedRoles.filter((id) => id !== roleId)
      : [...selectedRoles, roleId];
    form.setValue('roleIds', next, { shouldValidate: true });
  };

  const onSubmit = form.handleSubmit(
    async (values) => {
    try {
      if (isEdit) {
        await updateUser.mutateAsync({
          id: user.id,
          body: {
            displayName: values.displayName,
            status: values.status ?? 'ACTIVE',
            roleIds: values.roleIds ?? [],
          },
        });
      } else {
        await createUser.mutateAsync({
          username: values.username,
          displayName: values.displayName,
          password: values.password,
          roleIds: values.roleIds ?? [],
        });
      }
      onOpenChange(false);
    } catch (e) {
      if (isApiError(e) && e.code === 'USER_USERNAME_TAKEN') {
        form.setError('username', { message: e.message });
      }
      // 其余错误已由 use-system 的 onError 弹过 toast
      }
    },
    // 校验失败的兜底提示 —— 没有它,根级错误会让"点保存没反应"
    onFormInvalid,
  );

  const pending = createUser.isPending || updateUser.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑用户' : '新增用户'}</DialogTitle>
          <DialogDescription>
            {isEdit ? '用户名不可修改。修改密码请用"重置密码"' : '创建后可在列表中分配角色'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label>用户名 *</Label>
            <Input {...form.register('username')} disabled={isEdit} autoFocus={!isEdit} />
            {form.formState.errors.username !== undefined && (
              <p className="text-sm text-destructive">{form.formState.errors.username.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>显示名 *</Label>
            <Input {...form.register('displayName')} autoFocus={isEdit} />
            {form.formState.errors.displayName !== undefined && (
              <p className="text-sm text-destructive">
                {form.formState.errors.displayName.message}
              </p>
            )}
          </div>

          {!isEdit && (
            <div className="space-y-2">
              <Label>初始密码 *</Label>
              <Input type="password" autoComplete="new-password" {...form.register('password')} />
              {form.formState.errors.password !== undefined && (
                <p className="text-sm text-destructive">
                  {form.formState.errors.password.message}
                </p>
              )}
            </div>
          )}

          {isEdit && (
            <div className="space-y-2">
              <Label>状态</Label>
              <Select
                value={form.watch('status') ?? 'ACTIVE'}
                onValueChange={(v) => form.setValue('status', v as UserFormValues['status'])}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {USER_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{USER_STATUS_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label>角色</Label>
            <div className="flex flex-wrap gap-2 rounded-md border p-3">
              {roleOptions?.items.length === 0 && (
                <span className="text-sm text-muted-foreground">暂无可分配的角色</span>
              )}
              {roleOptions?.items.map((role) => {
                const checked = selectedRoles.includes(role.id);
                return (
                  <button
                    key={role.id}
                    type="button"
                    onClick={() => toggleRole(role.id)}
                    className={
                      checked
                        ? 'rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground'
                        : 'rounded-md border px-3 py-1 text-sm hover:bg-accent'
                    }
                  >
                    {role.name}
                  </button>
                );
              })}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={pending}>{pending ? '保存中...' : '保存'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
