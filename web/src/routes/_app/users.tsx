/**
 * 用户管理页。
 */

import { USER_STATUS_LABELS, UserListQuerySchema } from '@app/contracts';
import type { UserWire } from '@app/contracts';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Can } from '@/features/auth/can';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { UserFormDialog } from '@/features/system/user-form-dialog';
import { ResetPasswordDialog } from '@/features/system/reset-password-dialog';
import { useDeleteUser, useUserList } from '@/features/system/use-system';
import { useMe } from '@/features/auth/use-auth';

export const Route = createFileRoute('/_app/users')({
  validateSearch: UserListQuerySchema,
  component: UsersPage,
});

function UsersPage(): React.JSX.Element {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data, isLoading } = useUserList(search);
  const { data: me } = useMe();
  const deleteUser = useDeleteUser();

  const [editing, setEditing] = useState<UserWire | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<UserWire | null>(null);
  const [deleting, setDeleting] = useState<UserWire | null>(null);

  const page = search.page ?? 1;
  const size = search.size ?? 20;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / size));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">用户管理</h1>
          <p className="text-sm text-muted-foreground">共 {data?.total ?? 0} 个账号</p>
        </div>
        <Can perm="user:manage">
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-1 size-4" />
            新增用户
          </Button>
        </Can>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户名</TableHead>
              <TableHead>显示名</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-32 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 4 }, (_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))}

            {data?.items.map((user) => {
              const isSelf = user.id === me?.user.id;
              return (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.username}</TableCell>
                  <TableCell>{user.displayName}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {user.roles.length === 0 && (
                        <span className="text-sm text-muted-foreground">未分配</span>
                      )}
                      {user.roles.map((r) => (
                        <Badge key={r.id} variant="outline">{r.name}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.status === 'ACTIVE' ? 'default' : 'secondary'}>
                      {USER_STATUS_LABELS[user.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Can perm="user:manage">
                        <Button variant="ghost" size="icon" onClick={() => setEditing(user)}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setResetting(user)}>
                          <KeyRound className="size-4" />
                        </Button>
                        {/* 不能删自己 —— 删完就没人能管理系统了。后端也有同样的判断,
                            这里只是不让按钮出现,免得用户点了才被拒 */}
                        {!isSelf && (
                          <Button variant="ghost" size="icon" onClick={() => setDeleting(user)}>
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        )}
                      </Can>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
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

      <UserFormDialog open={creating} onOpenChange={setCreating} user={null} />
      <UserFormDialog open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)} user={editing} />
      <ResetPasswordDialog open={resetting !== null}
        onOpenChange={(o) => !o && setResetting(null)} user={resetting} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="确认删除用户"
        description={`确定要删除账号「${deleting?.username ?? ''}」吗?该用户的所有会话将立即失效。`}
        confirmText="删除"
        destructive
        onConfirm={async () => {
          if (deleting !== null) await deleteUser.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}
