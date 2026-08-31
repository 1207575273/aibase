import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { fileURLToPath, URL } from 'node:url';
// @ts-expect-error 纯 JS 模块,无类型声明;它被后端脚本与 vite 共用,刻意不引入构建步骤
import { ports, contextPrefix as ctxPrefix } from '../scripts/ports.mjs';

/**
 * 端口与上下文根 —— 直接复用 `scripts/ports.mjs`,不在这里重写一份。
 *
 * 那个模块负责读 `.env` 并把 contextPath 归一成确定形态,后端 config、
 * 开发脚本读的是同一份 `.env`,三方天然同源。
 *
 * 这里曾经自己 JSON.parse 一份 ports.json 并复制了一遍归一化函数 ——
 * 那是「同一段逻辑四处实现」的来源之一,改一处忘三处的经典配置。
 */

/**
 * dev server 绑定地址,与后端共用 `HOST` 变量(后端在 config 里读同一个)。
 *
 * vite 的 server.host 取值:`true` = 全部网卡、字符串 = 只绑那一个。
 * 默认 true 是有意的 —— 拿手机或同事电脑连开发机是常态需求,
 * 而 dev server 本来就只在开发时跑。要收紧就 `HOST=127.0.0.1 pnpm dev`。
 */
const devHost: true | string = process.env.HOST === undefined || process.env.HOST === '' || process.env.HOST === '0.0.0.0' || process.env.HOST === '::' ? true : process.env.HOST;

const contextPrefix: string = ctxPrefix;
/** vite base 必须带尾斜杠,否则生成的资源路径会少一道斜杠。 */
const contextBase = contextPrefix === '' ? '/' : `${contextPrefix}/`;
const apiPrefix = `${contextPrefix}/api`;

export default defineConfig({
  /**
   * 基路径。它同时决定三件事:
   *   1. 打包产物里 js/css 的引用路径
   *   2. dev server 的访问地址(http://localhost:7002/app/)
   *   3. import.meta.env.BASE_URL 的值 —— 前端路由与 axios 都从那里取,
   *      所以整条链路只需要在这里配一次
   */
  base: contextBase,

  plugins: [
    // 文件式路由:在 src/routes/ 下加一个文件就是一个路由,
    // routeTree.gen.ts 由插件自动生成(已 gitignore,不入库)
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    // Tailwind v4 走 vite 插件,不需要 postcss.config 和 tailwind.config
    tailwindcss(),
  ],

  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },

  server: {
    port: ports.web,
    // strictPort: 端口被占时直接报错,而不是静默换一个 ——
    // 静默换端口会导致"我明明改了代码怎么没生效"(浏览器开的是旧端口那个实例)
    strictPort: true,
    // 监听全部网卡。vite 默认只绑 localhost,后端却默认绑 0.0.0.0 ——
    // 两边不一致的表现很迷惑:同事拿内网 IP 能调通 API,一开页面却连不上,
    // 看起来像前端挂了,实际是 dev server 根本没在那张网卡上监听。
    // 用与后端同一个 HOST 变量,`HOST=127.0.0.1 pnpm dev` 能一次收紧前后端。
    host: devHost,
    proxy: {
      // 开发态前端跑在 :7002,API 在 :7001。生产是单端口同源,不需要 proxy。
      // 用 apiPrefix 作为 key,启用 contextPath 后自动变成 '/app/api',
      // 与前端实际发出的请求路径一致。
      [apiPrefix]: {
        target: `http://127.0.0.1:${ports.server}`,
        changeOrigin: true,
      },
    },
  },

  build: {
    // 生产由后端 serveStatic 托管这个目录
    outDir: 'dist',
    sourcemap: true,
  },
});
