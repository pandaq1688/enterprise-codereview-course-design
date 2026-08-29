import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHtmlReport } from '../src/html-report-renderer.js';

test('escapes script tags and does not include CDN or full source', () => {
  const html = renderHtmlReport({
    schemaVersion: 1,
    reviewId: 'r1',
    status: 'SUCCEEDED',
    request: { projectName: 'demo', projectDirDisplay: 'ws/demo', sourceMode: 'GIT_CHANGES' },
    source: { files: [{ path: 'src/a.cpp' }], rules: [] },
    result: {
      summary: '<script>alert(1)</script>',
      overallRisk: 'LOW',
      findings: [{
        findingId: 'F-001',
        title: '"onclick=',
        description: '<img src=x onerror=alert(1)>',
        status: 'KEPT',
        finalRisk: 'LOW',
        decisions: [{ policyId: 'PF-001', action: 'KEPT', reason: '保持', beforeRisk: 'LOW', afterRisk: 'LOW' }]
      }]
    },
    ai: { rawOutput: '<script>alert(1)</script>' },
    errors: []
  });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(/https:\/\//.test(html), false);
  assert.equal(html.includes('int main'), false);
});
