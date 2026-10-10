#!/usr/bin/env node
/**
 * 把模板仓库打成源码包 assets/template.tar.gz,供 init.mjs 初始化新项目。零依赖,只需 Node 与 git。
 *
 * 用法(在模板仓库的开发机上,模板改完并提交后执行):
 *   node pack.mjs [--from <模板仓库目录>] [--ref <分支 / tag / 提交,默认 HEAD>]
 *
 * --from 默认是本 skill 所在的模板仓库(<仓库>/.claude/skills/init-project)。
 *
 * 用 git archive 打包: 只含已提交的文件,不含 .git、node_modules、.env 等被忽略的内容;
 * 包头里记录提交号(init.mjs 读出来写进首次提交信息与 projects.json,便于追溯模板版本)。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = path.join(SKILL_ROOT, 'assets', 'template.tar.gz');
// init.mjs 解包时去掉第一层目录,这里必须带一层
const PREFIX = 'template/';

const fail = (msg) => {
  process.stderr.write(`[FAIL] ${msg}\n`);
  process.exit(1);
};
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

const argv = process.argv.slice(2);
const option = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const from = path.resolve(option('from') ?? path.join(SKILL_ROOT, '..', '..', '..'));
const ref = option('ref') ?? 'HEAD';

const top = git(from, ['rev-parse', '--show-toplevel']);
if (top.status !== 0) fail(`${from} 不是 git 仓库,用 --from 指定模板仓库目录`);
const commit = git(from, ['rev-parse', '--verify', `${ref}^{commit}`]);
if (commit.status !== 0) fail(`找不到 ${ref}: ${commit.stderr.trim()}`);
const sha = commit.stdout.trim();

// 只打已提交的内容: 工作区有未提交改动时提醒,避免以为改动已进包
const dirty = git(from, ['status', '--porcelain']).stdout.trim();
if (ref === 'HEAD' && dirty) process.stdout.write(`[WARN] 工作区有未提交的改动,不会进包:\n${dirty}\n`);

fs.mkdirSync(path.dirname(ASSET), { recursive: true });
const r = git(from, ['archive', '--format=tar.gz', `--prefix=${PREFIX}`, '-o', ASSET, sha]);
if (r.status !== 0) fail(`git archive 失败: ${r.stderr.trim()}`);

const kb = (fs.statSync(ASSET).size / 1024).toFixed(0);
process.stdout.write(`[PASS] ${path.relative(SKILL_ROOT, ASSET).replace(/\\/g, '/')}(${kb}KB),模板 ${top.stdout.trim()} @ ${sha.slice(0, 7)}\n`);
