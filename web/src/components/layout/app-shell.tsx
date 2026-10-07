/**
 * 应用外壳 —— 侧边菜单 + 顶栏 + 内容区。
 *
 * 菜单是**前端常量数组**,不是后端下发的菜单树。
 * 理由: 前端路由是编译期产物,运行时下发菜单会与实际路由持续漂移
 * (后台配了个菜单但前端没有对应页面 -> 点了 404)。
 * 每项带一个 perm 字段,按 can() 过滤即可 ——
 * 真要做数据库驱动的菜单时,把这个数组换成接口数据,权限判定逻辑一行不用改。
 */

import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { LogOut, Users, Shield, UserCog } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useLogout, useMe, usePermission } from '@/features/auth/use-auth';

interface MenuItem {
  path: string;
  label: string;
  icon: typeof Users;
  /** 需要的权限码。没有这个权限的用户看不到这一项。 */
  perm: string;
}

const MENUS: readonly MenuItem[] = [
  { path: '/users', label: '用户管理', icon: UserCog, perm: 'user:read' },
  { path: '/roles', label: '角色管理', icon: Shield, perm: 'role:read' },
];

export const AppShell = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const { data: me } = useMe();
  const can = usePermission();
  const logout = useLogout();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const visibleMenus = MENUS.filter((m) => can(m.perm));

  const handleLogout = async (): Promise<void> => {
    await logout.mutateAsync();
    await navigate({ to: '/login' });
  };

  return (
    <div className="flex min-h-screen">
      {/* 侧边栏 */}
      <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/30">
        <div className="flex h-14 items-center border-b px-4">
          <span className="font-semibold">AIBase</span>
        </div>

        <nav className="flex-1 space-y-1 p-2">
          {visibleMenus.map((item) => {
            const active = pathname.startsWith(item.path);
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
          {visibleMenus.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              当前账号没有任何可访问的模块
            </p>
          )}
        </nav>
      </aside>

      {/* 主区域 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-end gap-2 border-b px-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                {me?.user.displayName ?? '未登录'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="font-normal">
                <div className="text-sm font-medium">{me?.user.displayName}</div>
                <div className="text-xs text-muted-foreground">
                  {me?.roles.map((r) => r.name).join('、') || '无角色'}
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void handleLogout()}>
                <LogOut className="mr-2 size-4" />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
};
