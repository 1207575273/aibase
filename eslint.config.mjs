/**
 * eslint flat config —— 只为「架构边界」而存在,不开任何 recommended 预设。
 *
 * 干什么: 把分层纪律从口头约定变成编辑器里的实时红线。
 * 解决什么问题: 架构约束写在文档里没人看、看了也会忘,只有机器能持续执行。
 *   代码风格交给 tsc --noEmit + editorconfig,这里一条风格规则都不放 ——
 *   保持零噪音,任何一条红线都是真违规,团队才不会养成无视 lint 的习惯。
 *
 * 规则清单:
 *   R1  domain 不得依赖任何外层(application / infrastructure / interface)
 *   R1b application 不得依赖 infrastructure / interface
 *   R2  跨业务域不得 import 别域的 application(shared 公共内核豁免)
 *   R3  只有 interface 层可以 import @app/contracts(HTTP 契约不得内渗)
 *   R4  除 config 模块外禁止裸读 process.env
 *   R5  前端业务层不得直接 import axios(只走 api/http 封装)
 *
 * [重要] 加规则时必须做「注入探针」验证: 故意写一行违规代码,确认 eslint 真的报错,
 *   再删掉。曾见过的一个项目的 R3 第一版就是静默失效的假绿(boundaries v6 废弃了
 *   external 规则但旧写法不报错),没有探针根本发现不了。
 */
import boundaries from 'eslint-plugin-boundaries';
import tsParser from '@typescript-eslint/parser';

const TS_LANG = {
  parser: tsParser,
  parserOptions: { sourceType: 'module', ecmaVersion: 'latest' },
};

/** 测试文件不是架构边界,一律豁免:夹具经常需要跨层组装真实依赖。 */
const TEST_FILES = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/__fakes__/**'];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/generated/**',
      '**/routeTree.gen.ts',
      'server/prisma/**',
    ],
  },

  // ── R1 / R1b / R2: 后端分层与跨域边界 ────────────────────────────
  {
    files: ['server/src/**/*.ts'],
    ignores: TEST_FILES,
    languageOptions: TS_LANG,
    plugins: { boundaries },
    settings: {
      'import/resolver': { typescript: { project: 'server/tsconfig.json' } },
      // 元素粒度 = 层目录后的第一段,mode:folder 让深层文件也归属到所属域。
      // 例: domain/person/person.types.ts -> { type:'domain', dom:'person' }
      'boundaries/elements': [
        { type: 'domain', pattern: 'server/src/domain/*', mode: 'folder', capture: ['dom'] },
        { type: 'application', pattern: 'server/src/application/*', mode: 'folder', capture: ['dom'] },
        { type: 'infrastructure', pattern: 'server/src/infrastructure/*', mode: 'folder', capture: ['dom'] },
        { type: 'interface', pattern: 'server/src/interface/*', mode: 'folder', capture: ['dom'] },
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
              from: [{ type: 'domain' }],
              disallow: [
                { to: { type: 'application' } },
                { to: { type: 'infrastructure' } },
                { to: { type: 'interface' } },
              ],
              message:
                'R1: domain 不得依赖外层。domain 只放类型 + Repository 接口 + 纯函数,任何 IO 都通过接口反转出去。',
            },
            {
              // R1b —— 曾见过的一个项目没有这条,后果是 15 个 application 文件 import 了
              // infrastructure(其中 5 个直接 import PrismaClient)。所谓"有意识的读例外"
              // 一旦没有边界,就会变成默认写法。本模板不搞 CQRS,这个口子从一开始就焊死。
              from: [{ type: 'application' }],
              disallow: [{ to: { type: 'infrastructure' } }, { to: { type: 'interface' } }],
              message:
                'R1b: application 不得依赖 infrastructure/interface。需要数据请在 domain 定义 Repository 接口,由 composition 层注入实现。',
            },
            {
              from: [{ type: 'application' }, { type: 'domain' }],
              disallow: [
                { to: { type: 'application', captured: { dom: '!({{ from.captured.dom }}|shared)' } } },
              ],
              message:
                'R2: 跨域不得 import 别域的 application 业务逻辑。只 import 对方 domain 层的接口,在 composition 层注入。',
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
    files: ['server/src/{domain,application,infrastructure}/**/*.ts'],
    ignores: TEST_FILES,
    languageOptions: TS_LANG,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@app/contracts', '@app/contracts/*'],
              message:
                'R3: 只有 interface 层可以 import @app/contracts。内层需要 wire 形状,说明 HTTP 概念在往里渗 —— 请在 interface/http/<域>.wire.ts 写 toWire 映射。契约一旦内渗,HTTP 形状就反向决定了领域模型。',
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
    ignores: [...TEST_FILES, 'server/src/config/**'],
    languageOptions: TS_LANG,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
          message:
            'R4: 禁止裸读 process.env。请从 src/config/index.ts 导入已校验的 config —— 那里有 zod schema 和启动期 fail-fast,裸读会让配置漂移无法被发现。',
        },
      ],
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
