import { htmlEscape } from './shared/html-escape.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
function e(value) {
  return htmlEscape(value);
}

/**
 * @param {object[]} findings
 * @param {(finding: object) => boolean} predicate
 * @returns {object[]}
 */
function filterFindings(findings, predicate) {
  return (findings ?? []).filter(predicate);
}

/**
 * @param {object} finding
 * @returns {string}
 */
function renderFinding(finding) {
  return `<article class="finding">
  <h3>${e(finding.findingId)} — ${e(finding.title)}</h3>
  <p><strong>风险:</strong> ${e(finding.finalRisk)}</p>
  <p><strong>状态:</strong> ${e(finding.status)}</p>
  <p>${e(finding.description)}</p>
</article>`;
}

/**
 * @param {object[]} findings
 * @returns {string}
 */
function renderDecisionTrail(findings) {
  const parts = [];
  for (const finding of findings ?? []) {
    const decisions = finding.decisions ?? [];
    if (decisions.length === 0) {
      continue;
    }
    parts.push(`<article class="finding-decisions">
  <h3>${e(finding.findingId)}</h3>
  <ul>`);
    for (const decision of decisions) {
      parts.push(
        `<li>${e(decision.policyId)}: ${e(decision.action)} — ${e(decision.reason)} (${e(decision.beforeRisk)} → ${e(decision.afterRisk)})</li>`
      );
    }
    parts.push('</ul>\n</article>');
  }
  return parts.join('\n');
}

/**
 * @param {object} rule
 * @returns {string}
 */
function renderRuleLabel(rule) {
  if (typeof rule === 'string') {
    return e(rule);
  }
  if (rule && typeof rule === 'object') {
    return e(rule.name ?? rule.path ?? rule.id ?? JSON.stringify(rule));
  }
  return e(rule);
}

/**
 * @param {object} report
 * @returns {string}
 */
export function renderHtmlReport(report) {
  const request = report.request ?? {};
  const source = report.source ?? {};
  const result = report.result ?? {};
  const ai = report.ai ?? {};
  const findings = result.findings ?? [];
  const rules = report.rules ?? source.rules ?? [];
  const errors = report.errors ?? [];
  const recommendedActions = result.recommendedActions ?? [];

  const activeFindings = filterFindings(
    findings,
    (finding) =>
      finding.status !== 'DOWNGRADED' &&
      finding.status !== 'EXEMPTED' &&
      finding.status !== 'MERGED'
  );
  const downgradedFindings = filterFindings(findings, (finding) => finding.status === 'DOWNGRADED');
  const exemptedMergedFindings = filterFindings(
    findings,
    (finding) => finding.status === 'EXEMPTED' || finding.status === 'MERGED'
  );

  const fileItems = (source.files ?? [])
    .map((file) => `<li>${e(file.path)}</li>`)
    .join('');
  const ruleItems = rules.map((rule) => `<li>${renderRuleLabel(rule)}</li>`).join('');
  const errorItems = errors
    .map((error) => {
      if (typeof error === 'string') {
        return `<li>${e(error)}</li>`;
      }
      return `<li>${e(error.code)}: ${e(error.message)}</li>`;
    })
    .join('');
  const actionItems = recommendedActions.map((action) => `<li>${e(action)}</li>`).join('');

  const sections = [
    `<h2>概要</h2>
<dl>
  <dt>项目</dt><dd>${e(request.projectName)}</dd>
  <dt>目录</dt><dd>${e(request.projectDirDisplay)}</dd>
  <dt>模式</dt><dd>${e(request.sourceMode)}</dd>
  <dt>需求</dt><dd>${e(request.requirementFileDisplay)}</dd>
  <dt>审查 ID</dt><dd>${e(report.reviewId)}</dd>
  <dt>状态</dt><dd>${e(report.status)}</dd>
  <dt>创建时间</dt><dd>${e(report.createdAt)}</dd>
  <dt>完成时间</dt><dd>${e(report.completedAt)}</dd>
  <dt>耗时</dt><dd>${e(report.durationMs)} ms</dd>
  <dt>最终风险</dt><dd>${e(result.overallRisk)}</dd>
</dl>
<p>${e(result.summary)}</p>`,

    `<h2>输入与规则</h2>
<h3>输入文件</h3>
<ul>${fileItems || '<li>无</li>'}</ul>
<h3>生效规则</h3>
<ul>${ruleItems || '<li>无</li>'}</ul>`,

    `<h2>有效问题</h2>
${activeFindings.map(renderFinding).join('\n') || '<p>无</p>'}`,

    `<h2>降级</h2>
${downgradedFindings.map(renderFinding).join('\n') || '<p>无</p>'}`,

    `<h2>豁免与合并</h2>
${exemptedMergedFindings.map(renderFinding).join('\n') || '<p>无</p>'}`,

    `<h2>决策轨迹</h2>
${renderDecisionTrail(findings) || '<p>无</p>'}`,

    `<h2>AI 元数据</h2>
<dl>
  <dt>Provider</dt><dd>${e(ai.provider)}</dd>
  <dt>Model</dt><dd>${e(ai.model)}</dd>
  <dt>Duration</dt><dd>${e(ai.durationMs)} ms</dd>
  <dt>Exit Code</dt><dd>${e(ai.exitCode)}</dd>
  <dt>Raw Overall Risk</dt><dd>${e(ai.rawOverallRisk)}</dd>
  <dt>Stderr</dt><dd>${e(ai.stderrSummary)}</dd>
</dl>
<pre>${e(ai.rawOutput)}</pre>`,

    `<h2>错误</h2>
<ul>${errorItems || '<li>无</li>'}</ul>
<h3>建议操作</h3>
<ul>${actionItems || '<li>无</li>'}</ul>`
  ];

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${e(request.projectName ?? report.reviewId)} — 代码审查报告</title>
  <style>
    body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 960px; margin: 0 auto; padding: 1rem; color: #222; background: #fff; }
    h2 { border-bottom: 1px solid #ccc; padding-bottom: 0.25rem; margin-top: 2rem; }
    h3 { margin-top: 1rem; }
    .finding, .finding-decisions { border: 1px solid #ddd; padding: 1rem; margin: 1rem 0; border-radius: 4px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f5f5f5; padding: 1rem; border-radius: 4px; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 1rem; }
    dt { font-weight: bold; }
    ul { padding-left: 1.25rem; }
  </style>
</head>
<body>
${sections.join('\n\n')}
</body>
</html>`;
}
