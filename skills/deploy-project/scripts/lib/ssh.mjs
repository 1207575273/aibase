/**
 * SSH 连接、执行、上传。基于 ssh2(Windows 的系统 ssh 不支持直接用密码登录)。
 *
 * 密码只从环境变量 DEPLOY_PASSWORD 读,不进命令行参数(会出现在进程列表与历史里)、不进日志、不落盘。
 * 主机指纹: 首次连接只取指纹不登录,交给用户确认;确认后的指纹记进 deployments.json,之后每次比对。
 */

// ssh2 已打包为单文件(scripts/vendor/ssh2.cjs),skill 不需要 npm install;升级时用 esbuild 重新打包
import ssh2 from '../vendor/ssh2.cjs';

const { Client } = ssh2;

export class HostKeyUnconfirmed extends Error {
  constructor(fingerprint) {
    super(`主机指纹未确认: ${fingerprint}`);
    this.fingerprint = fingerprint;
  }
}

/** 单引号包裹,给 bash 用。 */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * @param {{host:string, port:number, user:string, password?:string, expectedFingerprint?:string}} target
 */
export const connect = (target) =>
  new Promise((resolve, reject) => {
    const conn = new Client();
    let seen;
    conn
      .on('ready', () => resolve({ conn, fingerprint: seen }))
      .on('error', (err) => {
        if (seen !== undefined && target.expectedFingerprint === undefined) reject(new HostKeyUnconfirmed(seen));
        else if (seen !== undefined && seen !== target.expectedFingerprint) {
          reject(new Error(`主机指纹与登记的不一致(登记 ${target.expectedFingerprint},实际 ${seen})。可能换了机器,也可能被劫持,先停下核实`));
        } else reject(err);
      })
      .connect({
        host: target.host,
        port: target.port,
        username: target.user,
        password: target.password,
        readyTimeout: 20_000,
        hostHash: 'sha256',
        hostVerifier: (hash) => {
          seen = `SHA256:${Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, '')}`;
          return target.expectedFingerprint !== undefined && seen === target.expectedFingerprint;
        },
      });
  });

/**
 * 执行一条 bash 命令。sudo 为 true 时以 root 执行;需要密码时从 stdin 喂给 sudo -S,不出现在命令里。
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export const exec = (conn, command, { sudo = false, sudoPassword, stream = false } = {}) =>
  new Promise((resolve, reject) => {
    const wrapped = sudo
      ? `sudo -S -p '' bash -c ${shq(command)}`
      : `bash -c ${shq(command)}`;
    conn.exec(wrapped, (err, ch) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      ch.on('data', (d) => {
        stdout += d;
        if (stream) process.stdout.write(d);
      });
      ch.stderr.on('data', (d) => {
        stderr += d;
        if (stream) process.stderr.write(d);
      });
      ch.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
      if (sudo && sudoPassword !== undefined) ch.write(`${sudoPassword}\n`);
      ch.end();
    });
  });

/** 上传本地文件到远端路径。 */
export const upload = (conn, localPath, remotePath) =>
  new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve()));
    });
  });
