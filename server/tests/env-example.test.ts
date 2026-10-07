/**
 * 配置门禁:代码读的每个环境变量都必须在 .env.example 里出现。
 *
 * .env.example 是"这个项目要配哪些变量"的唯一清单 —— 新人 cp 成 .env、沙箱平台照着注入。
 * 代码里加了变量而样例里没写,缺的键会**静默按默认值生效**,没人知道它可以配。
 * 可选项写成注释行(# KEY=值)也算登记过。
 *
 * 扫描范围是所有允许读 process.env 的地方: platform/config(运行时唯一入口)、
 * prisma.config.ts(迁移 CLI)、seed.ts(种子)。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(SERVER_ROOT, '..');

const ENV_READERS = ['src/platform/config/index.ts', 'prisma.config.ts', 'prisma/seed.ts'];

const readKeysInCode = (): string[] => {
  const keys = new Set<string>();
  for (const file of ENV_READERS) {
    const source = readFileSync(resolve(SERVER_ROOT, file), 'utf8');
    for (const m of source.matchAll(/process\.env(?:\[['"]([A-Z][A-Z0-9_]*)['"]\]|\.([A-Z][A-Z0-9_]*))/g)) {
      keys.add(m[1] ?? m[2] ?? '');
    }
  }
  keys.delete('');
  return [...keys].sort();
};

const readKeysInExample = (): Set<string> => {
  const text = readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf8');
  return new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] ?? ''));
};

describe('.env.example', () => {
  it('should_find_env_reads_when_scanning_code', () => {
    expect(readKeysInCode()).toContain('DATABASE_URL');
  });

  it('should_list_every_env_key_when_code_reads_it', () => {
    const documented = readKeysInExample();
    const missing = readKeysInCode().filter((key) => !documented.has(key));
    expect(missing, '这些变量代码在读,但 .env.example 里没登记(可选项写成 # KEY=默认值)').toEqual([]);
  });
});
