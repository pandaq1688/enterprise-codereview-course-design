import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewOutput } from '../src/review-result-parser.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

test('strips markdown fence and maps aliases', () => {
  const raw = '```json\n{"summary":"s","overallRisk":"low","findings":[{"category":"CORRECTNESS","riskLevel":"medium","title":"t","description":"d","filePath":"src/a.cpp","lineStart":10,"lineEnd":10,"evidence":"e","requirementReference":"","fixSuggestion":"f"}]}\n```';
  const parsed = parseReviewOutput(raw);
  assert.equal(parsed.overall_risk, 'LOW');
  assert.equal(parsed.findings[0].risk_level, 'MEDIUM');
  assert.equal(parsed.findings[0].file_path, 'src/a.cpp');
  assert.equal(parsed.findings[0].line_start, 10);
});

test('invalid json becomes AI_OUTPUT_INVALID_JSON without fabricating findings', () => {
  assert.throws(
    () => parseReviewOutput('not json'),
    (err) => err.code === ErrorCodes.AI_OUTPUT_INVALID_JSON && !('findings' in err)
  );
});

test('missing required finding fields becomes AI_OUTPUT_SCHEMA_INVALID', () => {
  assert.throws(
    () => parseReviewOutput(JSON.stringify({ summary: 's', overall_risk: 'LOW', findings: [{ title: 't' }] })),
    (err) => err.code === ErrorCodes.AI_OUTPUT_SCHEMA_INVALID
  );
});
