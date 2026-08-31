/**
 * 可访问地址计算 —— 枚举本机网卡,生成完整的访问地址列表。
 *
 * 干什么: 启动日志里列出所有能访问到本服务的地址。
 *
 * 解决什么问题:
 *   绑 0.0.0.0 时打印 `http://0.0.0.0:7001` 是个**没法直接点开的地址**,
 *   而现在的机器往往有一堆网卡(WSL、Docker、VPN、虚拟机),
 *   让人自己去 ipconfig 里翻 IP 再猜哪个通,纯属浪费时间。
 *   部署到服务器或容器里时,这几行就是运维确认"到底该访问哪个地址"的依据。
 *
 * [同步] `scripts/net.mjs` 里有一份等价实现给开发脚本用
 * (那边在 workspace 之外,没法 import 本文件)。
 */

import { networkInterfaces } from 'node:os';

/**
 * IP 排序:越靠前越可能是真实可连通的局域网地址。
 *   192.168.x    家用/办公路由器最常见
 *   10.x         企业内网
 *   172.16-31.x  企业内网,但 Docker 默认网段(172.17)也在这个范围
 *   其余         VPN、虚拟网卡等
 */
const ipRank = (ip: string): number => {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
};

/** 本机所有非内部 IPv4 地址,按连通概率排序。 */
export const lanIPv4 = (): string[] =>
  Object.values(networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address)
    .sort((x, y) => ipRank(x) - ipRank(y));

/**
 * @param port  监听端口
 * @param host  绑定地址。0.0.0.0 / :: / 空 表示监听全部网卡
 * @param base  上下文基路径,'/' 或 '/app/'(带尾斜杠)
 */
export const accessUrls = (port: number, host: string | undefined, base = '/'): string[] => {
  // 绑了某个具体地址就只有那一个能访问,列别的是误导
  const bindsAll = host === undefined || host === '' || host === '0.0.0.0' || host === '::';
  if (!bindsAll) return [`http://${host}:${port}${base}`];

  return [
    `http://localhost:${port}${base}`,
    ...lanIPv4().map((ip) => `http://${ip}:${port}${base}`),
  ];
};
