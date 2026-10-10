/**
 * 在目标机上安装缺失的软件。只在用户明确同意后由主流程调用(--install 参数)。
 *
 * 全部以 root 执行(装系统软件必需)。npm 全局包默认走 npmmirror —— 国内直连 npmjs 慢且常超时。
 * 装失败的典型原因(网络、源不可达)会原样回显,AI 可以在 tmp/ 写临时脚本处理,并把经验记进 LESSONS.md。
 */

import { exec } from './ssh.mjs';

const NPM_REGISTRY = process.env.DEPLOY_NPM_REGISTRY ?? 'https://registry.npmmirror.com';
const PNPM_VERSION = '10.33.0';

const STEPS = {
  'apt-get': {
    base: 'apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates',
    node: 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs',
    nginx: 'DEBIAN_FRONTEND=noninteractive apt-get install -y nginx',
    // Ubuntu 的 docker.io 不含 compose v2;官方源装的 docker-ce 则叫 docker-compose-plugin
    compose: 'DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2 || DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin',
  },
  dnf: {
    base: 'dnf install -y curl ca-certificates',
    node: 'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && dnf install -y nodejs',
    nginx: 'dnf install -y nginx',
    compose: 'dnf install -y docker-compose-plugin',
  },
  yum: {
    base: 'yum install -y curl ca-certificates',
    node: 'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && yum install -y nodejs',
    nginx: 'yum install -y nginx',
    compose: 'yum install -y docker-compose-plugin',
  },
};

const COMMON = {
  pnpm: `npm install -g pnpm@${PNPM_VERSION} --registry=${NPM_REGISTRY}`,
  pm2: `npm install -g pm2 --registry=${NPM_REGISTRY}`,
  docker: 'curl -fsSL https://get.docker.com | sh',
};

/** 国外官方 apt 源的域名。目标机用的是这些时,装软件前询问用户是否换国内镜像。 */
export const OFFICIAL_APT_HOSTS = ['archive.ubuntu.com', 'security.ubuntu.com', 'ports.ubuntu.com', 'deb.debian.org', 'security.debian.org'];

export const MIRRORS = {
  aliyun: 'mirrors.aliyun.com',
  tuna: 'mirrors.tuna.tsinghua.edu.cn',
  ustc: 'mirrors.ustc.edu.cn',
};

export const usesOfficialApt = (facts) => facts.pkg === 'apt-get' && facts.aptHosts.some((h) => OFFICIAL_APT_HOSTS.some((o) => h.endsWith(o)));

/**
 * 把 apt 源换成国内镜像。先按时间戳备份原文件,再把官方域名替换掉。
 * 兼容老格式 sources.list 与 Ubuntu 24.04 起的 .sources(deb822)。只支持 apt 系。
 */
export const switchMirror = async (conn, facts, mirror, sudoPassword) => {
  const host = MIRRORS[mirror];
  if (host === undefined) throw new Error(`不认识的镜像 ${mirror},可选: ${Object.keys(MIRRORS).join(' / ')}`);
  if (facts.pkg !== 'apt-get') throw new Error(`换源只支持 apt 系,当前包管理器 ${facts.pkg},请用户手工处理`);
  const hosts = OFFICIAL_APT_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('\\|');
  const script = [
    'set -e',
    'ts=$(date +%Y%m%d%H%M%S)',
    'for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do',
    '  [ -f "$f" ] || continue',
    `  grep -q '${hosts}' "$f" || continue`,
    '  cp "$f" "$f.bak-$ts"',
    `  sed -i 's#https\\?://\\(${hosts}\\)#http://${host}#g' "$f"`,
    '  echo "已换源: $f(备份 $f.bak-$ts)"',
    'done',
  ].join('\n');
  const r = await exec(conn, script, { sudo: facts.sudo !== 'root', sudoPassword });
  if (r.code !== 0) throw new Error(`换源失败: ${r.stderr || r.stdout}`);
  return r.stdout.trim() || '源文件里没有官方域名,无需改动';
};

/** 选了国内镜像时: node 从 npmmirror 下载官方二进制包(nodesource 在国外);docker 安装脚本走阿里云。 */
const mirrorAware = (mirror) =>
  mirror === undefined
    ? {}
    : {
        node: [
          'case "$(uname -m)" in x86_64) a=x64;; aarch64) a=arm64;; *) echo "不支持的架构 $(uname -m)"; exit 1;; esac',
          'base=https://registry.npmmirror.com/-/binary/node/latest-v22.x',
          'f=$(curl -fsSL "$base/SHASUMS256.txt" | grep -o "node-v22[^ ]*-linux-$a.tar.xz" | head -1)',
          '[ -n "$f" ] || { echo "找不到 node 22 的 linux-$a 二进制包"; exit 1; }',
          'command -v xz >/dev/null || (apt-get install -y xz-utils || dnf install -y xz || yum install -y xz)',
          'curl -fsSL "$base/$f" | tar -xJ -C /usr/local --strip-components=1',
          'node -v',
        ].join('\n'),
        docker: 'curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun',
      };

/** 安装顺序: node 必须在 pnpm / pm2 之前。 */
const ORDER = ['node', 'pnpm', 'pm2', 'nginx', 'docker', 'compose'];

/**
 * @param {string[]} items 要装的软件
 * @returns {Promise<{ok:string[], failed:{item:string, output:string}[]}>}
 */
export const install = async (conn, facts, items, sudoPassword, log, mirror) => {
  const steps = STEPS[facts.pkg];
  if (steps === undefined) throw new Error(`目标机没有可识别的包管理器(apt-get / dnf / yum),当前: ${facts.pkg || '无'}`);
  const sudo = { sudo: facts.sudo !== 'root', sudoPassword };
  const ok = [];
  const failed = [];

  const run = async (label, command) => {
    log(`安装 ${label} ...`);
    const r = await exec(conn, command, sudo);
    if (r.code !== 0) return `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-15).join('\n');
    return null;
  };

  const baseError = await run('基础工具(curl)', steps.base);
  if (baseError !== null) return { ok, failed: [{ item: 'base', output: baseError }] };

  for (const item of ORDER.filter((i) => items.includes(i))) {
    const command = mirrorAware(mirror)[item] ?? steps[item] ?? COMMON[item];
    const error = await run(item, command);
    if (error !== null) {
      failed.push({ item, output: error });
      continue;
    }
    if (item === 'nginx') {
      await exec(conn, facts.systemdUsable ? 'systemctl enable --now nginx' : 'nginx || true', sudo);
    }
    if (item === 'docker') {
      await exec(conn, `${facts.systemdUsable ? 'systemctl enable --now docker; ' : ''}usermod -aG docker ${facts.user}`, sudo);
    }
    ok.push(item);
  }
  return { ok, failed };
};
