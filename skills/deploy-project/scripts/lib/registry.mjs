/**
 * 部署登记 deployments.json(与 SKILL.md 同目录,只在本机)。
 *
 * 一条记录 = 一个项目在一个环境、一台机器上的部署: 机器(IP / 端口 / 账号 / 主机指纹)、部署方式、端口、目录、
 * 以及每次发布的结果。**不存密码**。
 * 用途: 下次部署沿用端口与目录、核对主机指纹、区分"端口被别人占了"与"被自己上一版占着"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deployments.json');

const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { deployments: [] });
const save = (data) => fs.writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`);

const keyOf = (d) => `${d.project}|${d.env}|${d.host}`;

export const findDeployment = (project, env, host) =>
  load().deployments.find((d) => keyOf(d) === `${project}|${env}|${host}`);

/** 同一台机器上已登记的指纹(任一项目)。 */
export const knownFingerprint = (host, port) =>
  load().deployments.find((d) => d.host === host && d.port === port)?.hostKey;

/** 新增或更新部署记录;release 追加到发布历史(最多留 20 条)。 */
export const recordDeployment = (record, release) => {
  const data = load();
  const i = data.deployments.findIndex((d) => keyOf(d) === keyOf(record));
  const prev = i >= 0 ? data.deployments[i] : { releases: [] };
  const next = { ...prev, ...record, releases: [...prev.releases, release].slice(-20) };
  if (i >= 0) data.deployments[i] = next;
  else data.deployments.push(next);
  save(data);
};

export const listDeployments = () => load().deployments;
