/**
 * 后端打包 —— esbuild 打成单文件。
 *
 * 干什么: 把 src/ 打成一个 dist/main.js,部署时只需要这个文件 + 原生依赖。
 *
 * ── 两个关键参数,删了会炸 ────────────────────────────────────
 *
 * 1. `--packages=external` 把第三方依赖留在外面(不打进来)。
 *    必须这样: Prisma 需要在运行时读它自己的文件,pino 的写盘走 worker thread
 *    (thread-stream 要真实文件路径),这些打进 bundle 都会坏掉。
 *
 * 2. 但 external 会把**自家 workspace 包也一起外部化** —— 这是个隐蔽的坑。
 *    `@app/contracts` 是源码包(exports 直指 .ts),运行期 Node 会去 import
 *    未编译的 TypeScript 源码,并在包内 `./common.js` 这种 TS 风格后缀上
 *    报 ERR_MODULE_NOT_FOUND。
 *
 *    修法是给它一个 alias 指向绝对路径 —— 不再是"裸包名",于是被正常打进 bundle。
 *
 *    [重要] 这个坑**只在契约包有运行时值(比如 zod schema)之后才暴露**:
 *    纯类型导出会被编译期擦除,根本走不到运行时解析。而且 dev 形态(tsx)不受影响,
 *    **只炸生产构建**。曾见过的一个项目正是这样上线才发现的。所以改这个脚本时别顺手清理它。
 */

import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(SERVER_ROOT, '..');

const CONTRACTS_ENTRY = resolve(REPO_ROOT, 'packages/contracts/src/index.ts');

/**
 * 两个入口共用同一套配置。
 *
 * 为什么 seed 也要打包: 开发态跑的是 `tsx server/prisma/seed.ts`,而 seed.ts
 * import 了 config / prisma-client / password-hasher 三个 **server/src 下的 TS 源码**。
 * 生产镜像里只有 dist、也不装 tsx,所以源码形态的 seed 在容器里根本跑不了 ——
 * 表现是容器起来了但一个能登录的账号都没有。打成单文件后 `node dist/seed.js` 即可。
 */
const shared = {
  bundle: true,
  platform: 'node',
  // 与 .nvmrc / package.json engines 保持一致 —— 三处对齐,不然会打出
  // 当前 Node 跑不了的语法
  target: 'node22',
  format: 'esm',
  packages: 'external',
  alias: {
    // 见文件头第 2 条。删掉产线必炸。
    '@app/contracts': CONTRACTS_ENTRY,
  },
  sourcemap: true,
  // 保留函数名:生产环境的错误堆栈才有可读性
  keepNames: true,
  logLevel: 'info',
  banner: {
    // ESM 里没有 __dirname/require,而某些依赖(如 Prisma 生成物)会用到。
    // 这段 shim 让它们在 ESM 产物里也能工作。
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
};

await build({
  ...shared,
  entryPoints: [resolve(SERVER_ROOT, 'src/main.ts')],
  outfile: resolve(SERVER_ROOT, 'dist/main.js'),
});

await build({
  ...shared,
  entryPoints: [resolve(SERVER_ROOT, 'prisma/seed.ts')],
  outfile: resolve(SERVER_ROOT, 'dist/seed.js'),
});

process.stdout.write('[PASS] 后端已打包到 server/dist/{main,seed}.js\n');
