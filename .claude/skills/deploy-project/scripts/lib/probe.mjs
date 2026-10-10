/**
 * 目标机探测(只读):系统、架构、CPU、内存、磁盘、软件版本、包管理器、sudo 权限、端口占用。
 *
 * 一次 SSH 执行跑完全部探测,每项输出 "KEY=value" 一行,解析成对象。
 * 任何一项失败都不影响其他项 —— 缺失本身就是信息。
 */

import { exec } from './ssh.mjs';

const PROBE_SCRIPT = String.raw`
p() { printf '%s=%s\n' "$1" "$2"; }
p os "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
p kernel "$(uname -sr)"
p arch "$(uname -m)"
p cpu_cores "$(nproc 2>/dev/null)"
p cpu_model "$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^ *//')"
p mem_total_mb "$(free -m 2>/dev/null | awk '/^Mem:/{print $2}')"
p mem_available_mb "$(free -m 2>/dev/null | awk '/^Mem:/{print $7}')"
p disk_home_free "$(df -h "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
p disk_opt_free "$(df -h /opt 2>/dev/null | awk 'NR==2{print $4}')"
p home "$HOME"
p user "$(id -un)"
p groups "$(id -nG)"
p docker "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
p docker_cli "$(command -v docker >/dev/null && docker --version 2>/dev/null)"
p compose "$(docker compose version --short 2>/dev/null)"
p node "$(node -v 2>/dev/null)"
p npm "$(npm -v 2>/dev/null)"
p pnpm "$(pnpm -v 2>/dev/null)"
p pm2 "$(pm2 -v 2>/dev/null | tail -1)"
p nginx "$(nginx -v 2>&1 | grep -o 'nginx/[0-9.]*')"
p systemd "$(command -v systemctl >/dev/null && systemctl is-system-running 2>/dev/null)"
p pkg "$(for m in apt-get dnf yum; do command -v $m >/dev/null && { echo $m; break; }; done)"
p apt_hosts "$(cat /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null | grep -vE '^[[:space:]]*#' | grep -oE 'https?://[^/ ]+' | sed 's#https\?://##' | sort -u | tr '\n' ',')"
if [ "$(id -u)" = "0" ]; then p sudo root
elif sudo -n true 2>/dev/null; then p sudo nopasswd
elif command -v sudo >/dev/null; then p sudo password
else p sudo none; fi
p ports "$( (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null | tail -n +3) | awk '{print $4}' | sed 's/.*://' | sort -un | tr '\n' ',')"
`;

/** "Linux"+"x86_64" -> linux-x64,与 Node 的 process.platform-process.arch 同一套写法,方便比对构建平台。 */
const toNodePlatform = (kernel, arch) => {
  const os = /linux/i.test(kernel) ? 'linux' : kernel.split(' ')[0].toLowerCase();
  const map = { x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' };
  return `${os}-${map[arch] ?? arch}`;
};

/**
 * 需要密码的 sudo,用登录密码验证一次是否可用。
 * 返回 'password-ok' / 'password-denied'。
 */
const verifySudoPassword = async (conn, password) => {
  if (password === undefined) return 'password-unknown';
  const r = await exec(conn, 'true', { sudo: true, sudoPassword: password });
  return r.code === 0 ? 'password-ok' : 'password-denied';
};

export const probe = async (conn, password) => {
  const r = await exec(conn, PROBE_SCRIPT);
  const facts = Object.fromEntries(
    r.stdout
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
  if (facts.sudo === 'password') facts.sudo = await verifySudoPassword(conn, password);
  facts.platform = toNodePlatform(facts.kernel ?? '', facts.arch ?? '');
  facts.ports = (facts.ports ?? '').split(',').filter(Boolean).map(Number);
  facts.inDockerGroup = (facts.groups ?? '').split(' ').includes('docker');
  facts.aptHosts = (facts.apt_hosts ?? '').split(',').filter(Boolean);
  // systemctl 存在不代表 systemd 在跑(容器里常见 offline),只有 running / degraded 才能用 systemctl 管服务
  facts.systemdUsable = ['running', 'degraded'].includes(facts.systemd);
  return facts;
};

/** 是否能以 root 执行(装软件、写 nginx 配置要用)。 */
export const canSudo = (facts) => ['root', 'nopasswd', 'password-ok'].includes(facts.sudo);

/** 给人看的摘要。 */
export const describe = (f) =>
  [
    `系统      ${f.os || '?'}(${f.kernel},${f.arch},平台 ${f.platform})`,
    `CPU       ${f.cpu_cores} 核  ${f.cpu_model || ''}`,
    `内存      共 ${f.mem_total_mb} MB,可用 ${f.mem_available_mb} MB`,
    `磁盘      家目录剩余 ${f.disk_home_free || '?'},/opt 剩余 ${f.disk_opt_free || '?'}`,
    `账号      ${f.user}(sudo: ${f.sudo};docker 组: ${f.inDockerGroup ? '是' : '否'})`,
    `docker    ${f.docker || '未安装或无权限'}  compose ${f.compose || '无'}`,
    `node      ${f.node || '无'}  npm ${f.npm || '无'}  pnpm ${f.pnpm || '无'}  pm2 ${f.pm2 || '无'}`,
    `nginx     ${f.nginx || '无'}  systemd ${f.systemd || '无'}  包管理器 ${f.pkg || '无'}`,
    ...(f.aptHosts.length > 0 ? [`apt 源    ${f.aptHosts.join(', ')}`] : []),
    `监听端口  ${f.ports.join(', ') || '(无)'}`,
  ].join('\n');
