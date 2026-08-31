/**
 * Toast 容器。
 *
 * [改动说明] shadcn 生成的原版依赖 next-themes 读当前主题 ——
 * 那是 Next.js 生态的库,本项目用不上。改成读 <html> 上的 .dark 类
 * (与 Tailwind 的暗色模式判定是同一个来源),去掉这个依赖。
 */

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

/** 订阅 <html> 的 class 变化,拿到当前是不是暗色模式。 */
const useIsDark = (): boolean => {
  const [isDark, setIsDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );

  useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => setIsDark(target.classList.contains('dark')));
    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return isDark;
};

const Toaster = ({ ...props }: ToasterProps): React.JSX.Element => {
  const isDark = useIsDark();

  return (
    <Sonner
      theme={isDark ? 'dark' : 'light'}
      className="toaster group"
      position="top-center"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
