/**
 * 可访问地址计算 —— 枚举本机网卡,生成用户能直接点开的完整地址列表。
 *
 * 干什么: 给定端口 + 绑定地址,算出所有可访问的 URL(含 contextPath)。
 *
 * 解决什么问题:
 *   只打印 `http://127.0.0.1:7002` 的话,想用手机或同事电脑访问的人
 *   得自己去 `ipconfig` 里翻 IP —— 而现在的开发机往往有一堆网卡
 *   (WSL、Docker、VPN、虚拟机、蓝牙),翻出来还得猜哪个是能连通的那个。
 *   直接把候选地址全列出来,并且**按连通概率排序**,省掉这一整步。
 *
 * 排序依据(前面的更可能是真实局域网):
 *   192.168.x  家用/办公路由器最常见
 *   10.x       企业内网
 *   172.16-31.x  企业内网,但 Docker 默认网段(172.17)也在这个范围
 *   其余       VPN、虚拟网卡等,排最后
 */

import { networkInterfaces } from 'node:os';

const ipRank = (ip) => {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
};

/** 本机所有非内部 IPv4 地址,按"更可能是真实局域网"排序。 */
export const lanIPv4 = () =>
  Object.values(networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address)
    .sort((x, y) => ipRank(x) - ipRank(y));

/**
 * 生成可访问的 URL 列表。
 *
 * @param {number} port 端口
 * @param {string|undefined} host 绑定地址。未设 / 0.0.0.0 / :: 视为监听全部网卡
 * @param {string} base 上下文基路径,'/' 或 '/app/'(必须带尾斜杠)
 * @returns {string[]} 第一个是本机地址,其余是局域网地址
 */
export const accessUrls = (port, host, base = '/') => {
  // 绑了某个具体地址就只有那一个能访问,列别的是误导
  const bindsAll = host === undefined || host === '' || host === '0.0.0.0' || host === '::';
  if (!bindsAll) return [`http://${host}:${port}${base}`];

  return [
    `http://localhost:${port}${base}`,
    ...lanIPv4().map((ip) => `http://${ip}:${port}${base}`),
  ];
};

/**
 * 排版成对齐的多行文本。
 * @param {string} label 左侧标签,如 '前端'
 * @param {string[]} urls
 */
export const formatUrls = (label, urls) => {
  const [first, ...rest] = urls;
  const pad = ' '.repeat(label.length + 2);
  return [
    `  ${label}  ${first}`,
    // 局域网地址缩进对齐,视觉上从属于上面那行
    ...rest.map((u) => `  ${pad}${u}`),
  ];
};
