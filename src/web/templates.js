import { htmlEscape } from '../shared/html-escape.js';

/**
 * Escape dynamic text for safe HTML insertion.
 * @param {unknown} value
 * @returns {string}
 */
function e(value) {
  return htmlEscape(value);
}

/**
 * Embed a value as a JS literal inside a <script> block.
 * JSON.stringify alone does not escape `</script>`.
 * @param {unknown} value
 * @returns {string}
 */
export function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * @param {object[]} summaries
 * @returns {string}
 */
function renderHistoryRows(summaries) {
  if (!summaries?.length) {
    return '<tr><td colspan="8">暂无历史报告</td></tr>';
  }
  return summaries
    .map(
      (s) => `<tr>
  <td>${e(s.createdAt)}</td>
  <td>${e(s.projectName)}</td>
  <td>${e(s.sourceMode)}</td>
  <td>${e(s.status)}</td>
  <td>${e(s.overallRisk)}</td>
  <td>${e(s.activeFindingCount)}</td>
  <td>${e(s.exemptedFindingCount)}</td>
  <td><a href="/reports/${e(s.reviewId)}">${e(s.reviewId)}</a></td>
</tr>`
    )
    .join('\n');
}

/**
 * @param {{ summaries?: object[] }} [opts]
 * @returns {string}
 */
export function renderHomePage({ summaries = [] } = {}) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>代码审查</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5; }
    label { display: block; margin: 0.75rem 0 0.25rem; }
    input, select { width: min(40rem, 100%); padding: 0.4rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 1.5rem; }
    th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; }
    button { margin-top: 1rem; padding: 0.5rem 1rem; }
  </style>
</head>
<body>
  <h1>创建审查任务</h1>
  <form id="review-form" method="post" action="/api/reviews">
    <label for="projectDir">项目目录</label>
    <input id="projectDir" name="projectDir" required>

    <label for="requirementFile">需求 Markdown</label>
    <input id="requirementFile" name="requirementFile" required>

    <label for="sourceMode">审查模式</label>
    <select id="sourceMode" name="sourceMode">
      <option value="GIT_CHANGES">Git 变更</option>
      <option value="FULL_DIRECTORY">全量目录</option>
    </select>

    <label>
      <input type="checkbox" name="checklist.enabled" value="true">
      启用 review-checklist
    </label>

    <label for="checklist.path">checklist 路径</label>
    <input id="checklist.path" name="checklist.path">

    <label for="checklist.includePaths">checklist 适用目录（逗号分隔）</label>
    <input id="checklist.includePaths" name="checklist.includePaths" value=".">

    <button type="submit">开始审查</button>
  </form>

  <h2>历史报告</h2>
  <table>
    <thead>
      <tr>
        <th>创建时间</th>
        <th>项目</th>
        <th>模式</th>
        <th>状态</th>
        <th>风险</th>
        <th>有效问题</th>
        <th>豁免</th>
        <th>报告</th>
      </tr>
    </thead>
    <tbody>
${renderHistoryRows(summaries)}
    </tbody>
  </table>

  <script>
    document.getElementById('review-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      const data = new FormData(form);
      const payload = {
        projectDir: data.get('projectDir'),
        requirementFile: data.get('requirementFile'),
        sourceMode: data.get('sourceMode'),
        checklist: {
          enabled: data.get('checklist.enabled') === 'true',
          path: data.get('checklist.path') || null,
          includePaths: String(data.get('checklist.includePaths') || '.')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        }
      };
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = await res.json();
      if (!res.ok) {
        alert((body.error && body.error.message) || res.statusText);
        return;
      }
      location.href = '/jobs/' + encodeURIComponent(body.reviewId);
    });
  </script>
</body>
</html>`;
}

/**
 * @param {{ reviewId: string }} opts
 * @returns {string}
 */
export function renderJobPage({ reviewId }) {
  const id = e(reviewId);
  const apiJobsPath = `/api/jobs/${String(reviewId)}`;
  const reportPath = `/reports/${String(reviewId)}`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>任务 ${id}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; }
    #error { color: #a00; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>任务状态</h1>
  <p>reviewId: <code>${id}</code></p>
  <p>状态: <strong id="status">加载中…</strong></p>
  <pre id="error"></pre>
  <p><a href="/">返回首页</a></p>
  <script>
    const apiUrl = ${safeJsonForScript(apiJobsPath)};
    const reportUrl = ${safeJsonForScript(reportPath)};
    const statusEl = document.getElementById('status');
    const errorEl = document.getElementById('error');

    async function poll() {
      try {
        const res = await fetch(apiUrl);
        if (!res.ok) {
          statusEl.textContent = 'NOT_FOUND';
          errorEl.textContent = '任务不存在';
          return;
        }
        const job = await res.json();
        statusEl.textContent = job.status;
        if (job.error) {
          errorEl.textContent = [job.error.code, job.error.message].filter(Boolean).join('\\n');
        } else {
          errorEl.textContent = '';
        }
        if (job.status === 'SUCCEEDED' || job.status === 'FAILED') {
          location.href = reportUrl;
          return;
        }
      } catch (err) {
        errorEl.textContent = String(err);
      }
      setTimeout(poll, 1000);
    }
    poll();
  </script>
</body>
</html>`;
}

/**
 * @param {object} report
 * @returns {string}
 */
export function renderReportPage(report) {
  const request = report.request ?? {};
  const result = report.result ?? {};
  const findings = result.findings ?? [];
  const errors = report.errors ?? [];

  const findingHtml = findings
    .map(
      (f) => `<article>
  <h3>${e(f.findingId)} — ${e(f.title)}</h3>
  <p>风险: ${e(f.finalRisk)} / 状态: ${e(f.status)}</p>
  <p>${e(f.description)}</p>
</article>`
    )
    .join('\n');

  const errorHtml = errors
    .map((err) => `<li>${e(err.code)}: ${e(err.message)}</li>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>报告 ${e(report.reviewId)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5; }
    article { border-top: 1px solid #ddd; padding: 0.75rem 0; }
  </style>
</head>
<body>
  <h1>审查报告</h1>
  <p>reviewId: <code>${e(report.reviewId)}</code></p>
  <p>项目: ${e(request.projectName)}</p>
  <p>模式: ${e(request.sourceMode)}</p>
  <p>状态: ${e(report.status)}</p>
  <p>最终风险: ${e(result.overallRisk)}</p>
  <p>有效问题: ${e(result.activeFindingCount)} / 豁免: ${e(result.exemptedFindingCount)}</p>
  <p>
    <a href="/reports/${e(report.reviewId)}/report.html">report.html</a> |
    <a href="/reports/${e(report.reviewId)}/report.json">report.json</a> |
    <a href="/">返回首页</a>
  </p>
  ${errors.length ? `<h2>错误</h2><ul>${errorHtml}</ul>` : ''}
  <h2>问题列表</h2>
  ${findingHtml || '<p>无</p>'}
</body>
</html>`;
}
