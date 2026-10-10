/**
 * 由 meta.json + plan.json + steps.jsonl (+ regression.json / verdict.json) 生成自包含的 report.html。
 * 截图用相对路径引用 shots/,运行目录整体搬到 e2e/archive/ 后仍能打开。
 */

import fs from 'node:fs';
import path from 'node:path';

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

export const readSteps = (runDir) => {
  const file = path.join(runDir, 'steps.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

/** 汇总: 检查点通过 / 失败数、动作出错数、控制台错误与失败请求数。 */
export const summarize = (steps) => ({
  actions: steps.filter((s) => s.kind === 'act').length,
  actionErrors: steps.filter((s) => s.kind === 'act' && s.result === 'error').length,
  checksPassed: steps.filter((s) => s.kind === 'check' && s.result === 'pass').length,
  checksFailed: steps.filter((s) => s.kind === 'check' && s.result === 'fail').length,
  consoleErrors: steps.reduce((n, s) => n + (s.newConsoleErrors?.length ?? 0), 0),
  failedRequests: steps.reduce((n, s) => n + (s.newFailedRequests?.length ?? 0), 0),
});

const VERDICT_VIEW = {
  pending: { cls: 'pending', text: '待用户验收' },
  pass: { cls: 'pass', text: '用户验收: 通过' },
  fail: { cls: 'fail', text: '用户验收: 不通过' },
};

const stepHtml = (s) => {
  const badge =
    s.kind === 'check'
      ? `<span class="badge ${s.result}">${s.result === 'pass' ? '[PASS]' : '[FAIL]'}</span>`
      : s.result === 'error'
        ? '<span class="badge fail">[ERROR]</span>'
        : '<span class="badge act">[ACT]</span>';
  const body =
    s.kind === 'check'
      ? `<div class="kv"><b>期望</b>${esc(s.expect)}</div><div class="kv"><b>实际</b>${esc(s.actual)}</div>` +
        (s.assert ? `<pre>${esc(s.assert)}</pre>` : '')
      : `${s.why ? `<div class="kv"><b>意图</b>${esc(s.why)}</div>` : ''}<div class="kv"><b>命令</b><code>${esc(s.command)}</code></div>` +
        (s.code ? `<pre>${esc(s.code)}</pre>` : '') +
        (s.error ? `<pre class="err">${esc(s.error)}</pre>` : '');
  const problems = [...(s.newConsoleErrors ?? []).map((e) => `控制台: ${e}`), ...(s.newFailedRequests ?? []).map((e) => `请求: ${e}`)];
  return `<div class="step ${s.kind}">
  <div class="step-head">${badge}<span class="seq">#${s.seq}</span><span class="url">${esc(s.url ?? '')}</span><span class="ts">${esc(s.ts)}</span></div>
  <div class="step-body">
    ${s.screenshot ? `<a href="${esc(s.screenshot)}" target="_blank"><img src="${esc(s.screenshot)}" loading="lazy" alt="步骤 ${s.seq} 截图"></a>` : '<div class="noshot muted">无截图</div>'}
    <div class="text">${body}${problems.length ? `<ul class="problems">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}</div>
  </div>
</div>`;
};

export const buildReport = (runDir) => {
  const meta = readJson(path.join(runDir, 'meta.json'));
  const plan = readJson(path.join(runDir, 'plan.json'));
  const regression = readJson(path.join(runDir, 'regression.json'));
  const verdict = readJson(path.join(runDir, 'verdict.json'));
  const steps = readSteps(runDir);
  const sum = summarize(steps);
  const v = VERDICT_VIEW[verdict?.result ?? 'pending'];

  const scenarioHtml = plan.scenarios
    .map((sc) => {
      const own = steps.filter((s) => s.scenario === sc.id);
      const failed = own.some((s) => s.result === 'fail' || s.result === 'error');
      return `<section class="scenario">
  <h2><span class="badge ${failed ? 'fail' : own.length ? 'pass' : 'pending'}">${failed ? '[FAIL]' : own.length ? '[PASS]' : '[SKIP]'}</span> ${esc(sc.id)} ${esc(sc.title)}</h2>
  <ul class="expect">${sc.expect.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
  ${own.map(stepHtml).join('\n') || '<p class="muted">没有执行任何步骤</p>'}
</section>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>E2E 报告 ${esc(meta.name)}</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --fg:#1f2328; --muted:#656d76; --line:#d0d7de; --pass:#1a7f37; --fail:#cf222e; --pending:#9a6700; --act:#0969da; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  main { max-width:1200px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:0 0 8px; }
  .verdict { padding:12px 16px; border-radius:8px; font-weight:600; margin:16px 0; border:1px solid; }
  .verdict.pending { color:var(--pending); background:#fff8c5; border-color:#d4a72c; }
  .verdict.pass { color:var(--pass); background:#dafbe1; border-color:#4ac26b; }
  .verdict.fail { color:var(--fail); background:#ffebe9; border-color:#ff8182; }
  .card, .scenario { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:4px 24px; }
  .kv b { display:inline-block; min-width:72px; color:var(--muted); font-weight:500; }
  .nums { display:flex; flex-wrap:wrap; gap:12px; margin-top:12px; }
  .num { border:1px solid var(--line); border-radius:6px; padding:6px 12px; } .num strong { font-size:18px; margin-right:4px; }
  .badge { font-family:ui-monospace,Consolas,monospace; font-weight:700; margin-right:6px; }
  .badge.pass { color:var(--pass); } .badge.fail { color:var(--fail); } .badge.pending { color:var(--pending); } .badge.act { color:var(--act); }
  .expect { margin:0 0 12px; color:var(--muted); }
  .step { border-top:1px solid var(--line); padding:12px 0; }
  .step-head { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; }
  .seq { font-weight:600; } .url { color:var(--muted); word-break:break-all; } .ts { margin-left:auto; color:var(--muted); font-size:12px; }
  .step-body { display:grid; grid-template-columns:360px minmax(0,1fr); gap:16px; margin-top:6px; align-items:start; }
  .noshot { border:1px dashed var(--line); border-radius:6px; padding:24px; text-align:center; }
  .step-body img { width:100%; border:1px solid var(--line); border-radius:6px; }
  pre { background:#f6f8fa; border:1px solid var(--line); border-radius:6px; padding:8px; overflow-x:auto; font:12px/1.5 ui-monospace,Consolas,monospace; white-space:pre-wrap; word-break:break-all; }
  pre.err { color:var(--fail); background:#fff5f5; }
  code { font:12px ui-monospace,Consolas,monospace; word-break:break-all; }
  .problems { color:var(--fail); margin:6px 0 0; padding-left:18px; }
  .muted { color:var(--muted); }
  @media (max-width:720px) { .step-body { grid-template-columns:1fr; } .ts { margin-left:0; } }
</style>
</head>
<body>
<main>
  <h1>E2E 报告: ${esc(meta.name)}</h1>
  <div class="muted">运行号 ${esc(meta.runId)}</div>
  <div class="verdict ${v.cls}">${v.text}${verdict ? `(${esc(verdict.by)},${esc(verdict.at)})${verdict.note ? `: ${esc(verdict.note)}` : ''}` : ''}</div>

  <div class="card">
    <div class="kv"><b>用户意图</b>${esc(plan.intent)}</div>
    <div class="grid" style="margin-top:8px">
      <div class="kv"><b>被测地址</b>${esc(meta.baseUrl)}</div>
      <div class="kv"><b>版本</b>${esc(meta.git.shortCommit)}(${esc(meta.git.branch)})${meta.git.dirty ? ' 有未提交改动' : ''}</div>
      <div class="kv"><b>提交说明</b>${esc(meta.git.subject)}</div>
      <div class="kv"><b>执行人</b>${esc(meta.operator)}</div>
      <div class="kv"><b>开始</b>${esc(meta.startedAt)}</div>
      <div class="kv"><b>结束</b>${esc(meta.finishedAt ?? '进行中')}</div>
      <div class="kv"><b>工具</b>playwright-cli ${esc(meta.pwcliVersion)}</div>
      <div class="kv"><b>回归脚本</b>${regression ? `${esc(regression.spec)} ${regression.passed ? '<span class="badge pass">[PASS]</span>' : '<span class="badge fail">[FAIL]</span>'}` : '未生成'}</div>
    </div>
    <div class="nums">
      <div class="num"><strong>${plan.scenarios.length}</strong>场景</div>
      <div class="num"><strong>${sum.actions}</strong>操作</div>
      <div class="num"><strong class="badge pass">${sum.checksPassed}</strong>检查通过</div>
      <div class="num"><strong class="badge fail">${sum.checksFailed}</strong>检查失败</div>
      <div class="num"><strong>${sum.actionErrors}</strong>操作出错</div>
      <div class="num"><strong>${sum.consoleErrors}</strong>控制台错误</div>
      <div class="num"><strong>${sum.failedRequests}</strong>失败请求</div>
    </div>
  </div>

  ${scenarioHtml}

  <div class="card muted">原始记录: steps.jsonl(每步一行)、meta.json、plan.json${regression ? '、regression.json' : ''}${verdict ? '、verdict.json' : ''};截图在 shots/,页面快照在 snapshots/。</div>
</main>
</body>
</html>
`;
  fs.writeFileSync(path.join(runDir, 'report.html'), html);
  return path.join(runDir, 'report.html');
};
