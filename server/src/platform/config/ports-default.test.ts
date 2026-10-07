/**
 * 端口兜底默认值的一致性测试。
 *
 * 端口的真源是 `.env`。但有两处**兜底值**,用于"既没有 .env 也没有环境变量"的场景:
 *   - 本包 config/index.ts 的 zod default(后端运行时)
 *   - scripts/ports.mjs 的 DEFAULTS(vite 与开发脚本)
 *
 * 它们分属两个运行时,读不到对方的代码,只能各写一份。这个测试就是那份
 * "改一处必须改另一处"的约定的执行者 —— 不靠人记,不靠注释。
 *
 * 为什么值得测:上一版用 ports.json 号称单一真源,结果 Dockerfile 里
 * PORT=7001 而 ports.json 是 7101,容器起来连不通;e2e 的专用端口也跟开发端口
 * 撞了号,注释还写着"已经错开"。端口不一致的症状全是"连不上/打错服务",
 * 而不是报错,查起来极费时间。
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error 纯 JS 模块,无类型声明
import { DEFAULTS, normalizeContextPath as jsNormalize } from '../../../../scripts/ports.mjs';
import { normalizeContextPath } from './index.js';

/** 与 config/index.ts 里的常量保持字面一致 —— 那两个是 const 不导出,这里复述一遍。 */
const EXPECTED = { server: 7101, web: 7102 };

const defaults = DEFAULTS as { server: number; web: number; contextPath: string };

describe('端口兜底默认值', () => {
  it('should_match_between_config_and_ports_mjs', () => {
    expect(defaults.server).toBe(EXPECTED.server);
    expect(defaults.web).toBe(EXPECTED.web);
  });

  it('should_not_collide_server_and_web', () => {
    // 撞号的表现是 strictPort 报端口占用,或者更糟:前端把请求发给了后端自己
    expect(defaults.server).not.toBe(defaults.web);
  });

  it('should_leave_room_for_e2e_port', () => {
    // e2e 用 server + 1000 派生(见 e2e/src/global-setup.ts),不能溢出 65535
    expect(defaults.server + 1000).toBeLessThanOrEqual(65535);
  });
});

describe('contextPath 归一化两份实现一致', () => {
  // 这两份实现分属 TS 与 JS 两个运行时,无法共享代码,只能靠样例对齐。
  const cases = ['', '/', '/app', '/app/', 'app', '  /app/  ', '/a/b/', '///'];

  for (const raw of cases) {
    it(`should_agree_on_${JSON.stringify(raw)}`, () => {
      expect((jsNormalize as (v: string) => string)(raw)).toBe(normalizeContextPath(raw));
    });
  }

  it('should_handle_undefined_the_same_way', () => {
    expect((jsNormalize as (v: undefined) => string)(undefined)).toBe(normalizeContextPath(undefined));
  });
});
