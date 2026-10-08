/**
 * 管理员初始密码只取 SEED_ADMIN_PASSWORD(单独成文件: seed.ts 一被导入就会执行,没法测)。
 *
 * 没设或为空串直接报错,不随机生成: 密码由人在 .env(部署时是 deploy/.env.<环境>)里定,
 * 随机生成的密码只打印一次,一旦没被看到就再也登录不了。
 * 空串也算没设: compose 的 ${SEED_ADMIN_PASSWORD:-} 在未配置时传的就是空串。
 */
export const requireAdminPassword = (envValue: string | undefined): string => {
  if (envValue === undefined || envValue === '') {
    throw new Error('缺少 SEED_ADMIN_PASSWORD: 在 .env(部署时在 deploy/.env.<环境>)里设置管理员初始密码后重试');
  }
  return envValue;
};
