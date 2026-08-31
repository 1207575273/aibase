/**
 * 角色管理页。
 */

import { DATA_SCOPE_LABELS, RoleListQuerySchema } from '@app/contracts';
import type { RoleWire } from '@app/contracts';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Can } from '@/features/auth/can';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RoleFormDialog } from '@/features/system/role-form-dialog';
import { useDeleteRole, useRoleList } from '@/features/system/use-system';

export const Route = createFileRoute('/_app/roles')({
  validateSearch: RoleListQuerySchema,
  component: RolesPage,
});

function RolesPage(): React.JSX.Element {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data, isLoading } = useRoleList(search);
  const deleteRole = useDeleteRole();

  const [editing, setEditing] = useState<RoleWire | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<RoleWire | null>(null);

  const page = search.page ?? 1;
  const size = search.size ?? 20;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / size));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">角色管理</h1>
          <p className="text-sm text-muted-foreground">共 {data?.total ?? 0} 个角色</p>
        </div>
        <Can perm="role:manage">
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-1 size-4" />
            新增角色
          </Button>
        </Can>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>角色码</TableHead>
              <TableHead>名称</TableHead>
              <TableHead>数据范围</TableHead>
              <TableHead>权限数</TableHead>
              <TableHead>使用人数</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }, (_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))}

            {data?.items.map((role) => (
              <TableRow key={role.id}>
                <TableCell className="font-mono text-sm">
                  {role.code}
                  {role.builtin && (
                    <Badge variant="outline" className="ml-2">内置</Badge>
                  )}
                  {role.superAdmin && (
                    <Badge className="ml-2">超管</Badge>
                  )}
                </TableCell>
                <TableCell>{role.name}</TableCell>
                <TableCell>{DATA_SCOPE_LABELS[role.dataScope]}</TableCell>
                <TableCell className="tabular-nums">
                  {/* 超管不看权限数 —— 它绕过一切权限码校验,显示数字会误导 */}
                  {role.superAdmin ? '全部' : role.permissions.length}
                </TableCell>
                <TableCell className="tabular-nums">{role.userCount}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Can perm="role:manage">
                      <Button variant="ghost" size="icon" onClick={() => setEditing(role)}>
                        <Pencil className="size-4" />
                      </Button>
                      {/* 内置角色不能删,按钮直接不出现 —— 后端也会拒绝,
                          但让用户点了才被告知"不行"是糟糕的体验 */}
                      {!role.builtin && (
                        <Button variant="ghost" size="icon" onClick={() => setDeleting(role)}>
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      )}
                    </Can>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">第 {page} / {totalPages} 页</span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1}
            onClick={() => void navigate({ search: (p) => ({ ...p, page: page - 1 }) })}>
            上一页
          </Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages}
            onClick={() => void navigate({ search: (p) => ({ ...p, page: page + 1 }) })}>
            下一页
          </Button>
        </div>
      </div>

      <RoleFormDialog open={creating} onOpenChange={setCreating} role={null} />
      <RoleFormDialog open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)} role={editing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="确认删除角色"
        description={
          (deleting?.userCount ?? 0) > 0
            ? `「${deleting?.name ?? ''}」还有 ${deleting?.userCount ?? 0} 个用户在使用,需要先解除关联才能删除。`
            : `确定要删除角色「${deleting?.name ?? ''}」吗?`
        }
        confirmText="删除"
        destructive
        onConfirm={async () => {
          if (deleting !== null) await deleteRole.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}
