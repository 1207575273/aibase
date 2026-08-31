/**
 * 角色表单弹窗 —— 权限树勾选是这里的核心。
 *
 * 权限树的数据来自 GET /auth/permission-catalog,而那个接口是从后端的
 * PERMISSIONS 代码常量直接导出的。所以新增一个权限码之后:
 * 后端加一行常量 -> 这个界面自动多出一项 -> 管理员就能勾。
 * 全程零迁移、零前端改动 —— 这正是"不建 Permission 表"换来的东西。
 */

import {
  CreateRoleBodySchema,
  DATA_SCOPES,
  DATA_SCOPE_LABELS,
  type CreateRoleBody,
  type RoleWire,
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
import { useCreateRole, usePermissionCatalog, useUpdateRole } from './use-system';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: RoleWire | null;
}

const EMPTY: CreateRoleBody = {
  code: '',
  name: '',
  description: '',
  dataScope: 'ALL',
  permissions: [],
};

export const RoleFormDialog = ({ open, onOpenChange, role }: Props): React.JSX.Element => {
  const isEdit = role !== null;
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const { data: catalog } = usePermissionCatalog();

  const form = useForm<CreateRoleBody>({
    resolver: zodResolver(CreateRoleBodySchema),
    defaultValues: EMPTY,
  });

  useEffect(() => {
    if (!open) return;
    form.reset(
      role === null
        ? EMPTY
        : {
            code: role.code,
            name: role.name,
            description: role.description ?? '',
            dataScope: role.dataScope,
            permissions: role.permissions as CreateRoleBody['permissions'],
          },
    );
  }, [open, role, form]);

  const selected = form.watch('permissions') ?? [];

  const togglePermission = (code: string): void => {
    const next = selected.includes(code as never)
      ? selected.filter((c) => c !== code)
      : [...selected, code as never];
    form.setValue('permissions', next, { shouldValidate: true });
  };

  /** 整组全选 / 全不选 —— 权限多了之后一个个点很痛苦。 */
  const toggleGroup = (codes: readonly string[]): void => {
    const allSelected = codes.every((c) => selected.includes(c as never));
    const next = allSelected
      ? selected.filter((c) => !codes.includes(c))
      : ([...new Set([...selected, ...codes])] as CreateRoleBody['permissions']);
    form.setValue('permissions', next, { shouldValidate: true });
  };

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (isEdit) {
        await updateRole.mutateAsync({
          id: role.id,
          body: {
            name: values.name,
            description: values.description,
            dataScope: values.dataScope,
            permissions: values.permissions,
          },
        });
      } else {
        await createRole.mutateAsync(values);
      }
      onOpenChange(false);
    } catch (e) {
      if (isApiError(e) && e.code === 'ROLE_CODE_TAKEN') {
        form.setError('code', { message: e.message });
      }
    }
  }, onFormInvalid);

  const pending = createRole.isPending || updateRole.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑角色' : '新增角色'}</DialogTitle>
          <DialogDescription>
            {role?.builtin === true
              ? '内置角色:可以改名字和权限,不能改角色码,也不能删除'
              : '角色码创建后不可修改'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>角色码 *</Label>
              <Input
                {...form.register('code')}
                disabled={isEdit}
                placeholder="OPERATOR"
              />
              {form.formState.errors.code !== undefined && (
                <p className="text-sm text-destructive">{form.formState.errors.code.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>角色名 *</Label>
              <Input {...form.register('name')} placeholder="操作员" />
              {form.formState.errors.name !== undefined && (
                <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>描述</Label>
            <Input {...form.register('description')} />
          </div>

          <div className="space-y-2">
            <Label>数据范围</Label>
            <Select
              value={form.watch('dataScope') ?? 'ALL'}
              onValueChange={(v) => form.setValue('dataScope', v as CreateRoleBody['dataScope'])}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {DATA_SCOPES.map((s) => (
                  <SelectItem key={s} value={s}>{DATA_SCOPE_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              「仅本人创建」只能看到自己创建的业务数据
            </p>
          </div>

          <div className="space-y-2">
            <Label>权限</Label>
            <div className="max-h-56 space-y-3 overflow-y-auto rounded-md border p-3">
              {catalog?.items.map((group) => {
                const codes = group.items.map((i) => i.code);
                const allSelected = codes.every((c) => selected.includes(c as never));
                return (
                  <div key={group.group} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{group.group}</span>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => toggleGroup(codes)}
                      >
                        {allSelected ? '取消全选' : '全选'}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {group.items.map((item) => {
                        const checked = selected.includes(item.code as never);
                        return (
                          <button
                            key={item.code}
                            type="button"
                            onClick={() => togglePermission(item.code)}
                            className={
                              checked
                                ? 'rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground'
                                : 'rounded-md border px-2.5 py-1 text-xs hover:bg-accent'
                            }
                          >
                            {item.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">已选 {selected.length} 项</p>
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
