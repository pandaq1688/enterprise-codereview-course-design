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

function minimalReport(overrides = {}) {
  return {
    schemaVersion: 1,
    reviewId: 'r1',
    status: 'SUCCEEDED',
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    durationMs: 60000,
    request: {
      projectName: 'demo',
      projectDirDisplay: 'ws/demo',
      sourceMode: 'GIT_CHANGES',
      requirementFileDisplay: 'req.md'
    },
    source: { files: [{ path: 'src/a.cpp' }], rules: [] },
    result: {
      summary: 'ok',
      overallRisk: 'LOW',
      findings: [],
      recommendedActions: []
    },
    ai: { provider: 'fake', model: null, durationMs: 100, exitCode: 0, rawOverallRisk: 'LOW', rawOutput: '', stderrSummary: '' },
    errors: [],
    ...overrides
  };
}

test('Task 10: renders shard summary when ai.shards present, no credentials leaked', () => {
  const html = renderHtmlReport(
    minimalReport({
      ai: {
        provider: 'fake',
        durationMs: 100,
        exitCode: 0,
        rawOverallRisk: 'LOW',
        rawOutput: '',
        stderrSummary: '',
        shards: [
          { index: 0, files: [{ path: 'src/f0.cpp' }, { path: 'src/f1.cpp' }], charCount: 2100 },
          { index: 1, files: [{ path: 'src/f2.cpp' }], charCount: 1800 }
        ]
      }
    })
  );
  assert.ok(html.includes('分片'), 'expected shard section label');
  assert.ok(html.includes('分片 0') || html.includes('分片0'));
  assert.match(html, /2.*文件|文件.*2/);
  assert.match(html, /2100|1,800|1800/);
  assert.equal(html.includes('password'), false);
  assert.equal(html.includes('token'), false);
  assert.equal(html.includes('secret'), false);
});

test('Task 10: renders analyzer source badge with analyzerId and ruleId', () => {
  const html = renderHtmlReport(
    minimalReport({
      result: {
        summary: 'ok',
        overallRisk: 'LOW',
        findings: [
          {
            findingId: 'F-001',
            title: '未使用的变量',
            description: '变量 x 未使用',
            status: 'KEPT',
            finalRisk: 'LOW',
            source: 'analyzer',
            analyzerId: 'clang-tidy',
            ruleId: 'misc-unused-parameters'
          },
          {
            findingId: 'F-002',
            title: 'AI finding',
            description: 'from model',
            status: 'KEPT',
            finalRisk: 'HIGH',
            source: 'ai'
          }
        ]
      }
    })
  );
  assert.ok(html.includes('clang-tidy'), 'expected analyzerId in HTML');
  assert.ok(html.includes('misc-unused-parameters'), 'expected ruleId in HTML');
  assert.ok(html.includes('来源') || html.includes('分析器'), 'expected source label');
  assert.ok(!html.match(/clang-tidy.*misc-unused-parameters.*AI finding/s) || html.includes('F-002'));
});

test('Task 10: no shard section when ai.shards absent (regression)', () => {
  const html = renderHtmlReport(minimalReport());
  assert.equal(html.includes('分片审计'), false);
  assert.equal(html.includes('分片 0'), false);
  assert.equal(html.includes('分片0'), false);
});
