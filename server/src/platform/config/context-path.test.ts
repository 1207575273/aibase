/**
 * contextPath 归一化的护栏。
 *
 * 为什么需要:
 *   同一套归一化逻辑有**两份**实现 —— 后端 config(TS)与 scripts/ports.mjs(JS)。
 *   不能合成一份是因为它们跑在两个加载环境里:后端走 TS 编译产物,
 *   而 vite 配置与开发脚本必须是能被 node 直接 import 的纯 JS。
 *
 *   漂移的后果特别隐蔽:后端算出 '/app'、vite 算出 '/app/',静态资源路径就多
 *   一道斜杠,表现为页面能开但样式全丢,且**只在启用 contextPath 时才炸**。
 *
 *   曾经有四份实现(还包括 vite.config.ts 与 e2e/global-setup.ts 各自复制的一份),
 *   靠逐字文本比对守着。现在那两处改为直接 import ports.mjs,实现自然收敛成两份,
 *   一致性也从比对源码文本升级为 ports-default.test.ts 里的**行为比对**。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeContextPath, REPO_ROOT } from './index.js';

describe('normalizeContextPath', () => {
  it.each([
    // 输入,          期望
    [undefined, ''],
    [null, ''],
    ['', ''],
    ['   ', ''],
    ['/', ''],
    ['app', '/app'],
    ['/app', '/app'],
    ['/app/', '/app'],
    ['/app//', '/app'],
    ['  /app/  ', '/app'],
    ['/a/b', '/a/b'],
    ['/a/b/', '/a/b'],
  ])('should_normalize_%p_to_%p', (input, expected) => {
    expect(normalizeContextPath(input as string | undefined)).toBe(expected);
  });

  it('should_never_end_with_slash', () => {
    for (const raw of ['/x/', '/x//', 'x/', '/a/b/c/']) {
      expect(normalizeContextPath(raw).endsWith('/')).toBe(false);
    }
  });

  it('should_always_start_with_slash_when_not_empty', () => {
    for (const raw of ['x', '/x', 'a/b']) {
      expect(normalizeContextPath(raw).startsWith('/')).toBe(true);
    }
  });
});

describe('归一化实现的跨文件一致性', () => {
  /** 归一化的核心三行。两份实现里都必须原样出现。 */
  const CORE_LINES = [
    "if (trimmed === '' || trimmed === '/') return '';",
    "const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;",
    "return withLeading.replace(/\\/+$/, '');",
  ];

  it.each([['scripts/ports.mjs']])('%s 的归一化逻辑应与后端一致', (relativePath) => {
    const source = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
    for (const line of CORE_LINES) {
      expect(
        source.includes(line),
        `${relativePath} 缺少这一行,说明两份归一化实现已经漂移:\n  ${line}\n` +
          '改动 contextPath 归一化时,两个文件必须同步修改。',
      ).toBe(true);
    }
  });
});
