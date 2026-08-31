/**
 * 管理员重置密码弹窗。
 *
 * 独立于用户编辑表单,因为它有额外的副作用:成功后该用户的**全部会话立即失效**。
 * 混在编辑表单里会让人不知道保存后发生了什么。
 */

import { PasswordSchema, type UserWire } from '@app/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { onFormInvalid } from '@/lib/form';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useResetPassword } from './use-system';

const FormSchema = z.object({ newPassword: PasswordSchema });
type FormValues = z.infer<typeof FormSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserWire | null;
}

export const ResetPasswordDialog = ({ open, onOpenChange, user }: Props): React.JSX.Element => {
  const resetPassword = useResetPassword();
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { newPassword: '' },
  });

  useEffect(() => {
    // 每次打开都清空 —— 密码框绝不能留着上一次的输入
    if (open) form.reset({ newPassword: '' });
  }, [open, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    if (user === null) return;
    await resetPassword.mutateAsync({ id: user.id, newPassword: values.newPassword });
    onOpenChange(false);
  }, onFormInvalid);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>重置密码</DialogTitle>
          <DialogDescription>
            为「{user?.displayName ?? ''}」设置新密码。该用户当前所有登录会话将立即失效。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label>新密码</Label>
            <Input type="password" autoComplete="new-password" {...form.register('newPassword')} />
            {form.formState.errors.newPassword !== undefined && (
              <p className="text-sm text-destructive">
                {form.formState.errors.newPassword.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={resetPassword.isPending}>
              {resetPassword.isPending ? '重置中...' : '确认重置'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
