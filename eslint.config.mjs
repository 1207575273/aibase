/**
 * eslint flat config —— 只为「架构边界」而存在,不开任何 recommended 预设。
 *
 * 干什么: 把分层纪律从口头约定变成编辑器里的实时红线。
 * 解决什么问题: 架构约束写在文档里没人看、看了也会忘,只有机器能持续执行。
 *   代码风格交给 tsc --noEmit + editorconfig,这里一条风格规则都不放 ——
 *   保持零噪音,任何一条红线都是真违规,团队才不会养成无视 lint 的习惯。
 *
 * server/src 的结构(按模块组织,模块内四层):
 *   lib/          纯类型与纯函数,零 IO、零框架,谁都能用
 *   platform/     横切基础设施:config / db / logger / http
 *   composition/  装配:唯一知道所有模块的地方
 *   modules/<m>/  业务模块,内分 domain / application / infra / interfaces
 *
 * 规则清单:
 *   R0  lib 只准 import lib;platform 不准 import 业务模块与 composition
 *   R1  domain 只准依赖 lib 与各模块的 domain(不碰 application / infra / interfaces / platform)
 *   R1b application 不得依赖 infra / interfaces / platform / composition
 *   R2  跨模块不得 import 别模块的 application / infra / interfaces(只走对方 domain)
 *   R3  只有 interfaces 层与 platform/http 可以 import @app/contracts(HTTP 契约不得内渗)
 *   R4  除 platform/config 外禁止裸读 process.env
 *   R5  前端业务层不得直接 import axios(只走 api/http 封装)
 *   R6  React hooks 规则:只在顶层调用 hooks、依赖数组写全(AI 生成代码最常见的隐性 bug)
 *
 * [重要] 加规则时必须做「注入探针」验证: 故意写一行违规代码,确认 eslint 真的报错,
 *   再删掉。曾见过的一个项目的 R3 第一版就是静默失效的假绿(boundaries v6 废弃了
 *   external 规则但旧写法不报错),没有探针根本发现不了。
 *   目录结构调整后同理 —— 元素 pattern 对不上新路径时规则会整体静默失效。
 */
import boundaries from 'eslint-plugin-boundaries';
import reactHooks from 'eslint-plugin-react-hooks';
import tsParser from '@typescript-eslint/parser';

const TS_LANG = {
  parser: tsParser,
  parserOptions: { sourceType: 'module', ecmaVersion: 'latest' },
};

/** 测试文件不是架构边界,一律豁免:夹具经常需要跨层组装真实依赖。 */
const TEST_FILES = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/__fakes__/**'];

const LAYERS = ['domain', 'application', 'infra', 'interfaces'];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/generated/**',
      '**/routeTree.gen.ts',
      'server/prisma/**',
      '.devdb/**',
    ],
  },

  // ── R0 / R1 / R1b / R2: 后端分层与跨模块边界 ─────────────────────
  {
    files: ['server/src/**/*.ts'],
    ignores: TEST_FILES,
    languageOptions: TS_LANG,
    plugins: { boundaries },
    settings: {
      'import/resolver': { typescript: { project: 'server/tsconfig.json' } },
      // 模块内四层按 (模块名, 层) 两段捕获;mode:folder 让深层文件也归属到所属层。
      // 例: modules/identity/interfaces/http/user.routes.ts -> { type:'interfaces', mod:'identity' }
      'boundaries/elements': [
        { type: 'lib', pattern: 'server/src/lib', mode: 'folder' },
        { type: 'platform', pattern: 'server/src/platform', mode: 'folder' },
        { type: 'composition', pattern: 'server/src/composition', mode: 'folder' },
        ...LAYERS.map((layer) => ({
          type: layer,
          pattern: `server/src/modules/*/${layer}`,
          mode: 'folder',
          capture: ['mod'],
        })),
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          // 只禁明确的坏样式,其余放行 —— 保持零噪音。
          default: 'allow',
          rules: [
            {
              from: [{ type: 'lib' }],
              disallow: [
                { to: { type: 'platform' } },
                { to: { type: 'composition' } },
                ...LAYERS.map((layer) => ({ to: { type: layer } })),
              ],
              message: 'R0: lib 只放纯类型与纯函数,不得依赖任何其他层。',
            },
            {
              from: [{ type: 'platform' }],
              disallow: [
                { to: { type: 'composition' } },
                ...LAYERS.map((layer) => ({ to: { type: layer } })),
              ],
              message:
                'R0: platform 是横切基础设施,不得依赖业务模块与 composition。需要模块信息请由 composition 作为参数传进来(参考 PrismaUnitOfWork 的 buildRepos)。',
            },
            {
              from: [{ type: 'domain' }],
              disallow: [
                { to: { type: 'application' } },
                { to: { type: 'infra' } },
                { to: { type: 'interfaces' } },
                { to: { type: 'platform' } },
                { to: { type: 'composition' } },
              ],
              message:
                'R1: domain 只准依赖 lib 与 domain。domain 只放类型 + Repository 接口 + 纯函数,任何 IO 都通过接口反转出去。',
            },
            {
              // R1b —— 曾见过的一个项目没有这条,后果是 15 个 application 文件 import 了
              // infrastructure(其中 5 个直接 import PrismaClient)。所谓"有意识的读例外"
              // 一旦没有边界,就会变成默认写法。本模板不搞 CQRS,这个口子从一开始就焊死。
              // platform/db 里就是 Prisma,所以 application 同样不许碰 platform。
              from: [{ type: 'application' }],
              disallow: [
                { to: { type: 'infra' } },
                { to: { type: 'interfaces' } },
                { to: { type: 'platform' } },
                { to: { type: 'composition' } },
              ],
              message:
                'R1b: application 不得依赖 infra / interfaces / platform / composition。需要数据请在 domain 定义 Repository 接口,由 composition 注入实现。',
            },
            {
              from: LAYERS.map((layer) => ({ type: layer })),
              disallow: ['application', 'infra', 'interfaces'].map((layer) => ({
                to: { type: layer, captured: { mod: '!{{ from.captured.mod }}' } },
              })),
              message:
                'R2: 跨模块只准 import 对方的 domain(类型与接口),不得 import 别模块的 application / infra / interfaces。实现由 composition 注入。',
            },
          ],
        },
      ],
    },
  },

  // ── R3: HTTP 契约不得内渗 ────────────────────────────────────────
  // 为什么用内置 no-restricted-imports 而不是 boundaries/external:
  //   boundaries v6 已把 external 标为 deprecated 并改了选择器语法,旧写法静默失效。
  //   R3 语义简单到不需要元素图谱,押在插件迁移期的 API 上不划算。
  {
    files: ['server/src/**/*.ts'],
    ignores: [...TEST_FILES, 'server/src/modules/*/interfaces/**', 'server/src/platform/http/**'],
    languageOptions: TS_LANG,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@app/contracts', '@app/contracts/*'],
              message:
                'R3: 只有 interfaces 层与 platform/http 可以 import @app/contracts。内层需要 wire 形状,说明 HTTP 概念在往里渗 —— 请在 modules/<模块>/interfaces/http/wire.ts 写 toWire 映射。契约一旦内渗,HTTP 形状就反向决定了领域模型。',
            },
          ],
        },
      ],
    },
  },

  // ── R4: 禁止裸读 process.env ─────────────────────────────────────
  // 曾见过的一个项目有 37 处裸读散在 16 个文件,导致同一个端口在四个地方写了三个不同的值。
  // 全部收口到 config 模块:zod 校验 + 启动 fail-fast + 类型化导出。
  {
    files: ['server/src/**/*.ts'],
    ignores: [...TEST_FILES, 'server/src/platform/config/**'],
    languageOptions: TS_LANG,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
          message:
            'R4: 禁止裸读 process.env。请从 src/platform/config/index.ts 导入已校验的 config —— 那里有 zod schema 和启动期 fail-fast,裸读会让配置漂移无法被发现。',
        },
      ],
    },
  },

  // ── R6: React hooks 规则 ─────────────────────────────────────────
  // 只开两条,不用插件的 recommended 预设(v7 的预设附带一批 React Compiler 规则,噪音大)。
  // exhaustive-deps 用 error 而不是 warn: 依赖漏写的后果是闭包拿到旧值或无限重渲染,
  // 运行时不报错、测试也很难覆盖,只有 lint 能在写下那一刻拦住。
  {
    files: ['web/src/**/*.{ts,tsx}'],
    languageOptions: {
      ...TS_LANG,
      parserOptions: { ...TS_LANG.parserOptions, ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  // ── R5: 前端业务层不得直接碰 HTTP 库 ─────────────────────────────
  {
    files: ['web/src/**/*.{ts,tsx}'],
    ignores: [...TEST_FILES, 'web/src/api/http.ts'],
    languageOptions: {
      ...TS_LANG,
      parserOptions: { ...TS_LANG.parserOptions, ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'axios',
              message:
                'R5: 业务层不要直接 import axios。走 src/api/http.ts 的封装 —— 拦截器、错误归一化、401 跳登录都在那里,绕过去会让错误处理散成好几种写法。',
            },
          ],
        },
      ],
    },
  },
];
