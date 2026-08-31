/**
 * 确认对话框 —— 删除等不可逆操作前的二次确认。
 *
 * 为什么不用浏览器原生 confirm(): 它会**阻塞整个 JS 线程**,样式无法定制,
 * 而且在某些场景下会被浏览器静默拦截(用户勾了"阻止此页面创建更多对话框")。
 * 基于 Dialog 的实现还自带 a11y —— 焦点陷阱、Esc 关闭、aria 属性都是 Radix 给的。
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作用红色按钮,让用户在点下去之前多看一眼。 */
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
}

export const ConfirmDialog = ({
  open,
  onOpenChange,
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  destructive = false,
  onConfirm,
}: Props): React.JSX.Element => {
  const [pending, setPending] = useState(false);

  const handleConfirm = async (): Promise<void> => {
    setPending(true);
    try {
      await onConfirm();
    } finally {
      // finally 里复位:操作失败时也要让按钮恢复可点,
      // 否则用户改完输入想重试却发现按钮永远转圈
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelText}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => void handleConfirm()}
            disabled={pending}
          >
            {pending ? '处理中...' : confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
