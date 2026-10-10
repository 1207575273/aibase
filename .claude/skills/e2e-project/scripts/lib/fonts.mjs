/**
 * Linux 沙箱的中文字体: 检查,缺了按用户同意下载到用户目录(不需要 root)。
 *
 * [为什么] 精简镜像常常一个字体都没有: 页面文字渲染成空白方块(截图证据作废),
 *   Chromium 处理文本输入要过 fontconfig,缺字体时浏览器还可能崩溃("browser has been closed")。
 * [来源] 沙箱没有 curl / tar,也装不了系统字体包。从 npm 镜像下载带 TTF 的思源黑体包,
 *   用 Node 解包,只取常规与粗体两个文件(woff2 不行,fontconfig 不认)。
 * [生效] 生成自己的 fonts.conf(先 include 系统配置,再加我们的字体目录),
 *   e2e.mjs 启动时设 FONTCONFIG_FILE,pwcli 与回归测试的浏览器进程都继承它。
 *   系统连 /etc/fonts/fonts.conf 都没有时同样生效。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const FONT_PACKAGE_URL = 'https://registry.npmmirror.com/@expo-google-fonts/noto-sans-sc/-/noto-sans-sc-0.4.4.tgz';
const FONT_FILES = ['package/400Regular/NotoSansSC_400Regular.ttf', 'package/700Bold/NotoSansSC_700Bold.ttf'];
const FONT_DIR = path.join(os.homedir(), '.local', 'share', 'fonts', 'e2e-noto-sans-sc');
export const FONTS_CONF = path.join(os.homedir(), '.cache', 'e2e-project', 'fonts.conf');
const FONT_CACHE_DIR = path.join(os.homedir(), '.cache', 'e2e-project', 'fontconfig');
const SYSTEM_FONT_DIRS = ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'), path.join(os.homedir(), '.local', 'share', 'fonts')];
/** 文件名看得出是中文字体的常见命名 */
const CJK_NAME = /cjk|[-_]sc[-_.]|notosanssc|hans|wqy|wenquanyi|droidsansfallback|sourcehan|simhei|simsun|msyh|pingfang|noto.*cjk/i;
const FONT_EXT = /\.(ttf|otf|ttc)$/i;

export const needsFontCheck = () => process.platform === 'linux';

const listFontFiles = (dir, depth = 0) => {
  if (depth > 4 || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return listFontFiles(full, depth + 1);
    return FONT_EXT.test(e.name) ? [full] : [];
  });
};

/** 有没有中文字体: 有 fc-list 就问 fontconfig,没有就按文件名在常见字体目录里找。 */
export const findCjkFonts = () => {
  const fc = spawnSync('fc-list', [':lang=zh', 'file'], { encoding: 'utf8' });
  if (fc.status === 0 && fc.stdout.trim()) return fc.stdout.trim().split('\n').map((l) => l.replace(/:\s*$/, ''));
  return SYSTEM_FONT_DIRS.flatMap((d) => listFontFiles(d)).filter((f) => CJK_NAME.test(path.basename(f)));
};

/** e2e.mjs 启动时调用: 装过我们的字体就让子进程用我们的 fonts.conf(用户已显式设置的不覆盖)。 */
export const applyFontsConf = () => {
  if (needsFontCheck() && fs.existsSync(FONTS_CONF)) process.env.FONTCONFIG_FILE ??= FONTS_CONF;
};

const TAR_BLOCK = 512;
const tarField = (buf, start, len) => buf.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');

/** 下载字体包,只解出 FONT_FILES,写 fonts.conf。返回装好的文件列表。 */
export const installFonts = async () => {
  const res = await fetch(FONT_PACKAGE_URL);
  if (!res.ok) throw new Error(`下载字体包失败: HTTP ${res.status}(${FONT_PACKAGE_URL})`);
  const tar = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
  fs.mkdirSync(FONT_DIR, { recursive: true });
  const written = [];
  let offset = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (header.every((b) => b === 0)) break;
    const name = tarField(header, 0, 100);
    const size = parseInt(tarField(header, 124, 12).trim() || '0', 8);
    if (FONT_FILES.includes(name)) {
      const target = path.join(FONT_DIR, path.basename(name));
      fs.writeFileSync(target, tar.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK + size));
      written.push(target);
    }
    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  if (written.length !== FONT_FILES.length) throw new Error(`字体包里没找到预期的文件: ${FONT_FILES.join(', ')}`);

  fs.mkdirSync(path.dirname(FONTS_CONF), { recursive: true });
  fs.writeFileSync(
    FONTS_CONF,
    `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<!-- 由 e2e-project 生成: 先沿用系统配置(没有也不报错),再加入下载的中文字体 -->
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${FONT_DIR}</dir>
  <cachedir>${FONT_CACHE_DIR}</cachedir>
</fontconfig>
`,
  );
  return written;
};
