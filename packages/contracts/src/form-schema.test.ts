/**
 * 表单 schema 与表单实际值的相容性护栏。
 *
 * ── 为什么需要这个测试 ────────────────────────────────────────
 *
 * 真实发生过的 bug:用户编辑弹窗「点保存没反应,页面也没有任何提示」。
 *
 * 根因是拿**请求体 schema**(`z.strictObject`)当表单的 zodResolver。
 * 表单为了新增/编辑共用一个组件,始终持有全部字段;
 * 而请求体 schema 只认自己那几个,多出来的被判成 `unrecognized_keys` ——
 * 校验直接失败,且 issue 的 `path` 是 `[]`(根路径),
 * 落不到任何输入框上,所以界面上一片安静。
 *
 * 这类 bug 的可怕之处:类型检查过、lint 过、后端测试全绿,
 * 只有真的点一下那个按钮才会发现。所以必须在契约层用测试钉死:
 * **表单 schema 必须能接受表单实际持有的全部字段**。
 */

import { describe, expect, it } from 'vitest';
import { CreateUserFormSchema, UserFormSchema } from './user.js';
import { CreateRoleBodySchema } from './role.js';
import { LoginFormSchema } from './auth.js';

describe('用户表单 schema', () => {
  /** 表单实际持有的值 —— 与 user-form-dialog.tsx 的 EMPTY / reset 保持一致。 */
  const formValues = {
    username: 'alice',
    displayName: '爱丽丝',
    password: '',
    status: 'ACTIVE' as const,
    roleIds: [] as string[],
  };

  it('should_accept_all_form_fields_in_edit_mode', () => {
    // ★ 编辑模式:密码留空,username 只读但仍在表单里。
    // 用请求体 schema 的话这里会因为 username/password 是"未知的键"而失败。
    const result = UserFormSchema.safeParse(formValues);
    expect(result.success, formatIssues(result)).toBe(true);
  });

  it('should_accept_all_form_fields_in_create_mode', () => {
    // ★ 新增模式:status 在表单里但不在创建请求体里。
    const result = CreateUserFormSchema.safeParse({
      ...formValues,
      password: 'a-valid-password',
    });
    expect(result.success, formatIssues(result)).toBe(true);
  });

  it('should_require_password_only_in_create_mode', () => {
    // 编辑模式允许空密码(改密走独立入口)
    expect(UserFormSchema.safeParse({ ...formValues, password: '' }).success).toBe(true);
    // 新增模式必须填,且要满足长度
    expect(CreateUserFormSchema.safeParse({ ...formValues, password: '' }).success).toBe(false);
    expect(CreateUserFormSchema.safeParse({ ...formValues, password: 'short' }).success).toBe(
      false,
    );
  });

  it('should_still_validate_display_name', () => {
    // 放开未知键不等于放弃校验 —— 该管的字段还得管
    const result = UserFormSchema.safeParse({ ...formValues, displayName: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['displayName']);
  });

  it('should_not_produce_root_level_errors', () => {
    // ★ 这条是那个 bug 的直接护栏:
    // 表单 schema 产生的错误必须**都能落到具体字段上**,
    // 否则界面无处显示,用户就会看到"点保存没反应"。
    const result = UserFormSchema.safeParse({
      ...formValues,
      displayName: '',
      username: 'x', // 太短
      extraUiField: 'whatever', // 模拟将来加的纯 UI 字段
    });
    expect(result.success).toBe(false);
    for (const issue of result.error?.issues ?? []) {
      expect(issue.path.length, `根级错误无法显示在界面上: ${issue.message}`).toBeGreaterThan(0);
    }
  });
});

describe('其他表单 schema 与表单值相容', () => {
it('role 表单值应被 CreateRoleBodySchema 接受', () => {
    // role 编辑模式也用 CreateRoleBodySchema(含 code),表单里 code 一直在,所以相容
    const formValues = {
      code: 'OPERATOR',
      name: '操作员',
      description: '',
      dataScope: 'ALL' as const,
      permissions: ['user:read'] as const,
    };
    const result = CreateRoleBodySchema.safeParse(formValues);
    expect(result.success, formatIssues(result)).toBe(true);
  });

  it('login 表单值应被 LoginFormSchema 接受', () => {
    const result = LoginFormSchema.safeParse({ username: 'admin', password: 'admin12345' });
    expect(result.success, formatIssues(result)).toBe(true);
  });
});

/** 失败时把 issue 打出来 —— 只报 "expected true to be false" 没法定位。 */
const formatIssues = (result: { success: boolean; error?: { issues: unknown[] } }): string =>
  result.success ? '' : JSON.stringify(result.error?.issues, null, 2);
