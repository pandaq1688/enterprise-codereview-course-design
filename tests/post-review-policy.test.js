import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPostReviewPolicy } from '../src/post-review-policy.js';
import { rawFinding, selected } from './helpers/policy-fixtures.js';

function decision(finding, policyId) {
  return finding.decisions.find((d) => d.policyId === policyId);
}

test('PF-001 normalizes risk case, illegal enums, and path slashes', () => {
  const result = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({ risk_level: 'medium', description: '确定的空指针问题', evidence: 'p->x' }),
      rawFinding({ risk_level: 'FOO', category: 'WEIRD', file_path: 'src\\b.cpp', line_start: 1, line_end: 1 }),
      rawFinding({ risk_level: 'LOW', file_path: 'src\\c.cpp', line_start: 2, line_end: 2, evidence: 'x=1' })
    ],
    selectedFiles: [
      selected('src/a.cpp', [3], 10),
      selected('src/b.cpp', [1], 10),
      selected('src/c.cpp', [2], 10)
    ],
    sourceMode: 'FULL_DIRECTORY'
  });

  assert.equal(result.findings[0].findingId, 'F-001');
  assert.equal(result.findings[0].finalRisk, 'MEDIUM');
  assert.equal(result.findings[0].originalRisk, 'MEDIUM');
  const d0 = decision(result.findings[0], 'PF-001');
  assert.ok(d0);
  assert.equal(d0.action, 'CORRECTED');
  assert.equal(typeof d0.reason, 'string');
  assert.match(d0.reason, /[\u4e00-\u9fff]/);

  assert.equal(result.findings[1].findingId, 'F-002');
  assert.equal(result.findings[1].finalRisk, 'LOW');
  assert.equal(result.findings[1].category, 'OTHER');
  assert.equal(result.findings[1].filePath, 'src/b.cpp');
  const d1 = decision(result.findings[1], 'PF-001');
  assert.ok(d1);
  assert.equal(d1.action, 'CORRECTED');
  assert.match(d1.reason, /[\u4e00-\u9fff]/);

  assert.equal(result.findings[2].filePath, 'src/c.cpp');
  const d2 = decision(result.findings[2], 'PF-001');
  assert.ok(d2);
  assert.equal(d2.action, 'CORRECTED');
  assert.match(d2.reason, /[\u4e00-\u9fff]/);
});

test('PF-002 exempts findings outside selected files', () => {
  const result = applyPostReviewPolicy({
    rawFindings: [rawFinding({ file_path: 'src/other.cpp', line_start: 1, line_end: 1 })],
    selectedFiles: [selected('src/a.cpp', [1], 10)],
    sourceMode: 'FULL_DIRECTORY'
  });

  const f = result.findings[0];
  assert.equal(f.status, 'EXEMPTED');
  const d = decision(f, 'PF-002');
  assert.ok(d);
  assert.equal(d.action, 'EXEMPTED');
  assert.match(d.reason, /OUT_OF_SCOPE_FILE/);
  assert.match(d.reason, /[\u4e00-\u9fff]/);
});

test('PF-003 exempts out-of-range lines and downgrades non-crash off-diff findings', () => {
  const outOfRange = applyPostReviewPolicy({
    rawFindings: [rawFinding({ line_start: 99, line_end: 99, evidence: 'x' })],
    selectedFiles: [selected('src/a.cpp', [3], 10)],
    sourceMode: 'FULL_DIRECTORY'
  });
  assert.equal(outOfRange.findings[0].status, 'EXEMPTED');
  const dExempt = decision(outOfRange.findings[0], 'PF-003');
  assert.ok(dExempt);
  assert.equal(dExempt.action, 'EXEMPTED');
  assert.match(dExempt.reason, /[\u4e00-\u9fff]/);

  const downgraded = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        category: 'CORRECTNESS',
        risk_level: 'HIGH',
        line_start: 1,
        line_end: 1,
        description: '逻辑错误',
        evidence: 'return 1'
      })
    ],
    selectedFiles: [selected('src/a.cpp', [5], 10)],
    sourceMode: 'GIT_CHANGES'
  });
  assert.equal(downgraded.findings[0].finalRisk, 'LOW');
  const dDown = decision(downgraded.findings[0], 'PF-003');
  assert.ok(dDown);
  assert.equal(dDown.action, 'DOWNGRADED');
  assert.equal(dDown.afterRisk, 'LOW');
  assert.match(dDown.reason, /[\u4e00-\u9fff]/);

  const crashKept = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        category: 'MEMORY_SAFETY',
        risk_level: 'HIGH',
        line_start: 1,
        line_end: 1,
        description: '空指针解引用',
        evidence: '对空指针解引用 p->x'
      })
    ],
    selectedFiles: [selected('src/a.cpp', [5], 10)],
    sourceMode: 'GIT_CHANGES'
  });
  assert.equal(crashKept.findings[0].finalRisk, 'HIGH');
  const dCrash = decision(crashKept.findings[0], 'PF-003');
  assert.ok(!dCrash || dCrash.action !== 'DOWNGRADED');
});

test('PF-003 downgrades mid/high risk when line numbers are missing or non-integer', () => {
  const missing = applyPostReviewPolicy({
    rawFindings: [
      {
        category: 'CORRECTNESS',
        risk_level: 'HIGH',
        title: '逻辑错误',
        description: '确定的逻辑错误',
        file_path: 'src/a.cpp',
        evidence: 'return 1',
        requirement_reference: '',
        fix_suggestion: '',
        fix_code: ''
      }
    ],
    selectedFiles: [selected('src/a.cpp', [3], 10)],
    sourceMode: 'FULL_DIRECTORY'
  });
  assert.equal(missing.findings[0].lineStart, null);
  assert.equal(missing.findings[0].finalRisk, 'LOW');
  const dMissing = decision(missing.findings[0], 'PF-003');
  assert.ok(dMissing);
  assert.equal(dMissing.action, 'DOWNGRADED');
  assert.equal(dMissing.afterRisk, 'LOW');
  assert.match(dMissing.reason, /[\u4e00-\u9fff]/);

  const nonInteger = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        risk_level: 'MEDIUM',
        description: '确定的逻辑错误',
        evidence: 'return 1',
        line_start: 'abc',
        line_end: 3.5
      })
    ],
    selectedFiles: [selected('src/a.cpp', [3], 10)],
    sourceMode: 'FULL_DIRECTORY'
  });
  assert.equal(nonInteger.findings[0].lineStart, null);
  assert.equal(nonInteger.findings[0].finalRisk, 'LOW');
  const dNonInt = decision(nonInteger.findings[0], 'PF-003');
  assert.ok(dNonInt);
  assert.equal(dNonInt.action, 'DOWNGRADED');
  assert.equal(dNonInt.afterRisk, 'LOW');
  assert.match(dNonInt.reason, /[\u4e00-\u9fff]/);
});

test('PF-004 does not treat bare punctuation as concrete code evidence', () => {
  const dotOnly = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        title: '可能存在问题',
        description: '这里可能有缺陷',
        evidence: '.',
        line_start: 3,
        line_end: 3
      })
    ],
    selectedFiles: [selected()],
    sourceMode: 'FULL_DIRECTORY'
  });
  assert.equal(dotOnly.findings[0].status, 'EXEMPTED');
  const dDot = decision(dotOnly.findings[0], 'PF-004');
  assert.ok(dDot);
  assert.equal(dDot.action, 'EXEMPTED');

  const parenNote = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        title: '可能存在问题',
        description: '这里可能有缺陷',
        evidence: '(见说明)',
        line_start: 3,
        line_end: 3
      })
    ],
    selectedFiles: [selected()],
    sourceMode: 'FULL_DIRECTORY'
  });
  assert.equal(parenNote.findings[0].status, 'EXEMPTED');
  const dParen = decision(parenNote.findings[0], 'PF-004');
  assert.ok(dParen);
  assert.equal(dParen.action, 'EXEMPTED');
});

test('PF-004 exempts speculative findings without concrete evidence', () => {
  const speculative = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        title: '可能存在问题',
        description: '这里可能有空指针',
        evidence: '',
        line_start: 3,
        line_end: 3
      })
    ],
    selectedFiles: [selected()],
    sourceMode: 'FULL_DIRECTORY'
  });
  assert.equal(speculative.findings[0].status, 'EXEMPTED');
  const d = decision(speculative.findings[0], 'PF-004');
  assert.ok(d);
  assert.equal(d.action, 'EXEMPTED');
  assert.match(d.reason, /[\u4e00-\u9fff]/);

  const concrete = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        category: 'MEMORY_SAFETY',
        title: '空指针',
        description: 'p 可能为空时解引用',
        evidence: 'p->x',
        line_start: 3,
        line_end: 3
      })
    ],
    selectedFiles: [selected()],
    sourceMode: 'FULL_DIRECTORY'
  });
  assert.notEqual(concrete.findings[0].status, 'EXEMPTED');
  assert.ok(!decision(concrete.findings[0], 'PF-004') || decision(concrete.findings[0], 'PF-004').action !== 'EXEMPTED');
});

test('PF-005 exempts unknown third-party and upgrade-path conclusions', () => {
  const result = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        description: '未知第三方接口在旧版本升级路径下会失败',
        evidence: '无本仓库代码',
        line_start: 3,
        line_end: 3,
        risk_level: 'MEDIUM'
      })
    ],
    selectedFiles: [selected()],
    sourceMode: 'FULL_DIRECTORY'
  });

  assert.equal(result.findings[0].status, 'EXEMPTED');
  const d = decision(result.findings[0], 'PF-005');
  assert.ok(d);
  assert.equal(d.action, 'EXEMPTED');
  assert.match(d.reason, /[\u4e00-\u9fff]/);
});
