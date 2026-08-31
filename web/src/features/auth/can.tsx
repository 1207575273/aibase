/**
 * 权限门控组件 —— 没权限就不渲染。
 *
 * @example
 * <Can perm="person:create">
 *   <Button>新增人员</Button>
 * </Can>
 *
 * [重要] 这只是**显隐控制,不是安全边界**。后端的 requirePermission 才是。
 * 藏起来的按钮,用 curl 照样能调对应接口。
 */

import type { PermissionCode } from '@app/contracts';
import type { ReactNode } from 'react';
import { usePermission } from './use-auth';

interface CanProps {
  /** 权限码。类型是联合类型,拼错就是编译错误。 */
  perm: PermissionCode;
  children: ReactNode;
  /** 没权限时渲染什么。默认什么都不渲染。 */
  fallback?: ReactNode;
}

export const Can = ({ perm, children, fallback = null }: CanProps): ReactNode => {
  const can = usePermission();
  return can(perm) ? children : fallback;
};
