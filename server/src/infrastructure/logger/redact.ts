/**
 * 日志脱敏 —— 递归按**键名**清洗,不依赖预先声明路径。
 *
 * ── 为什么不用 pino 内置的 redact ────────────────────────────
 *
 * pino 的 `redact.paths` 是**路径匹配**:必须提前声明
 * `password`、`*.password`、`req.body.password`… 每一层。
 * 实测确认它漏掉 `deep.deeper.password` —— 因为没人声明那条路径。
 *
 * 而真实场景里敏感字段出现在哪一层是无法预知的:
 * 有人 `logger.error('保存失败', { err, input })`,而 input 里嵌着 user 对象,
 * 那个 passwordHash 就落盘了。等发现时日志已经写了几个月。
 *
 * 所以这里按**键名子串**递归匹配 —— 只要键名里含 password / token 等,
 * 不管它藏多深都会被替换。代价是每条日志多一次递归遍历,
 * 对日志量正常的业务系统完全可以接受(而且只在真正要输出的级别才做)。
 */

/**
 * 敏感键名。**大小写不敏感的子串匹配** ——
 * 'passwordHash' / 'oldPassword' / 'API_KEY' 都会被 'password' / 'apikey' 命中,
 * 不需要穷举每个变体。
 */
const SENSITIVE_KEYS = [
  'password',
  'token',
  'authorization',
  'cookie',
  'secret',
  'apikey',
  'api_key',
  'privatekey',
  'passphrase',
  'credential',
  'sessionid',
];

export const REDACTED = '[REDACTED]';

const isSensitive = (key: string): boolean => {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((k) => lower.includes(k));
};

/**
 * 递归清洗,顺带把不可 JSON 序列化的值转成可读形式。
 *
 * depth 上限防两件事:循环引用导致的爆栈,以及"有人把整个 Prisma 客户端
 * 塞进日志"这种一行刷屏几千字符的情况。日志不是转储对象的地方。
 */
export const sanitize = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return '[Object]';
  if (value === null || value === undefined) return value;

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Set) return sanitize([...value], depth + 1);
  if (value instanceof Map) return sanitize(Object.fromEntries(value), depth + 1);

  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => sanitize(v, depth + 1));
    return value.length > 20 ? [...head, `...(${value.length - 20} more)`] : head;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitive(k) ? REDACTED : sanitize(v, depth + 1);
    }
    return out;
  }

  return value;
};
