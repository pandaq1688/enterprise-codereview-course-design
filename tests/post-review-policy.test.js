import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPostReviewPolicy } from '../src/post-review-policy.js';
import { analyzerRawFinding, rawFinding, selected } from './helpers/policy-fixtures.js';

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

test('PF-006 caps maintainability, weak performance, and OTHER mid/high risk at LOW', () => {
  const result = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        category: 'MAINTAINABILITY',
        risk_level: 'HIGH',
        title: '命名不佳',
        description: '变量命名难以阅读',
        evidence: 'int x',
        line_start: 3,
        line_end: 3
      }),
      rawFinding({
        category: 'PERFORMANCE',
        risk_level: 'HIGH',
        title: '可能偏慢',
        description: '这段代码看起来不够快',
        evidence: 'doWork()',
        line_start: 3,
        line_end: 3,
        file_path: 'src/b.cpp'
      }),
      rawFinding({
        category: 'OTHER',
        risk_level: 'CRITICAL',
        title: '杂项问题',
        description: '其他类型的严重声称',
        evidence: 'foo()',
        line_start: 3,
        line_end: 3,
        file_path: 'src/c.cpp'
      })
    ],
    selectedFiles: [
      selected('src/a.cpp', [3], 10),
      selected('src/b.cpp', [3], 10),
      selected('src/c.cpp', [3], 10)
    ],
    sourceMode: 'FULL_DIRECTORY'
  });

  assert.equal(result.findings[0].finalRisk, 'LOW');
  const dMaint = decision(result.findings[0], 'PF-006');
  assert.ok(dMaint);
  assert.equal(dMaint.action, 'DOWNGRADED');
  assert.equal(dMaint.afterRisk, 'LOW');
  assert.match(dMaint.reason, /[\u4e00-\u9fff]/);

  assert.equal(result.findings[1].finalRisk, 'LOW');
  const dPerf = decision(result.findings[1], 'PF-006');
  assert.ok(dPerf);
  assert.equal(dPerf.action, 'DOWNGRADED');
  assert.equal(dPerf.afterRisk, 'LOW');
  assert.match(dPerf.reason, /[\u4e00-\u9fff]/);

  assert.equal(result.findings[2].finalRisk, 'LOW');
  const dOther = decision(result.findings[2], 'PF-006');
  assert.ok(dOther);
  assert.equal(dOther.action, 'DOWNGRADED');
  assert.equal(dOther.afterRisk, 'LOW');
  assert.match(dOther.reason, /[\u4e00-\u9fff]/);
});

test('PF-006 caps are not undone by PF-007 floor on 服务不可用 or 进程退出', () => {
  const result = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        category: 'MAINTAINABILITY',
        risk_level: 'HIGH',
        title: '结构混乱',
        description: '模块耦合过高可能导致服务不可用',
        evidence: 'class Foo',
        line_start: 3,
        line_end: 3
      }),
      rawFinding({
        category: 'OTHER',
        risk_level: 'CRITICAL',
        title: '杂项声称',
        description: '声称会导致进程退出',
        evidence: 'exitPath()',
        line_start: 3,
        line_end: 3,
        file_path: 'src/b.cpp'
      }),
      rawFinding({
        category: 'PERFORMANCE',
        risk_level: 'HIGH',
        title: '偏慢',
        description: '响应慢时服务不可用',
        evidence: 'doWork()',
        line_start: 3,
        line_end: 3,
        file_path: 'src/c.cpp'
      })
    ],
    selectedFiles: [
      selected('src/a.cpp', [3], 10),
      selected('src/b.cpp', [3], 10),
      selected('src/c.cpp', [3], 10)
    ],
    sourceMode: 'FULL_DIRECTORY'
  });

  assert.equal(result.findings[0].finalRisk, 'LOW');
  assert.ok(decision(result.findings[0], 'PF-006'));
  assert.ok(!decision(result.findings[0], 'PF-007') || decision(result.findings[0], 'PF-007').action !== 'CORRECTED');

  assert.equal(result.findings[1].finalRisk, 'LOW');
  assert.ok(decision(result.findings[1], 'PF-006'));
  assert.ok(!decision(result.findings[1], 'PF-007') || decision(result.findings[1], 'PF-007').action !== 'CORRECTED');

  assert.equal(result.findings[2].finalRisk, 'LOW');
  assert.ok(decision(result.findings[2], 'PF-006'));
  assert.ok(!decision(result.findings[2], 'PF-007') || decision(result.findings[2], 'PF-007').action !== 'CORRECTED');
});

test('PF-007 floors severe memory issues at HIGH and caps non-catastrophic CRITICAL', () => {
  const uaf = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        category: 'MEMORY_SAFETY',
        risk_level: 'MEDIUM',
        title: '释放后使用',
        description: '对象释放后仍被访问',
        evidence: 'use-after-free: ptr->field after free(ptr)',
        line_start: 3,
        line_end: 3
      })
    ],
    selectedFiles: [selected()],
    sourceMode: 'FULL_DIRECTORY'
  });
  assert.ok(['HIGH', 'CRITICAL'].includes(uaf.findings[0].finalRisk));
  assert.notEqual(uaf.findings[0].finalRisk, 'MEDIUM');
  assert.notEqual(uaf.findings[0].finalRisk, 'LOW');
  const dFloor = decision(uaf.findings[0], 'PF-007');
  assert.ok(dFloor);
  assert.match(dFloor.reason, /[\u4e00-\u9fff]/);

  const bounds = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        category: 'MEMORY_SAFETY',
        risk_level: 'CRITICAL',
        title: '数组越界',
        description: '读取超出数组边界',
        evidence: 'buf[i] 越界访问',
        line_start: 3,
        line_end: 3
      })
    ],
    selectedFiles: [selected()],
    sourceMode: 'FULL_DIRECTORY'
  });
  assert.equal(bounds.findings[0].finalRisk, 'HIGH');
  const dCap = decision(bounds.findings[0], 'PF-007');
  assert.ok(dCap);
  assert.equal(dCap.action, 'DOWNGRADED');
  assert.equal(dCap.afterRisk, 'HIGH');
  assert.match(dCap.reason, /[\u4e00-\u9fff]/);
});

test('PF-008 downgrades requirement mismatch without reference; keeps when acceptance violated', () => {
  const missingRef = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        category: 'REQUIREMENT_MISMATCH',
        risk_level: 'HIGH',
        title: '需求不符',
        description: '返回值不符合约定',
        evidence: 'return 1',
        requirement_reference: '',
        line_start: 3,
        line_end: 3
      })
    ],
    selectedFiles: [selected()],
    sourceMode: 'FULL_DIRECTORY'
  });
  assert.equal(missingRef.findings[0].finalRisk, 'LOW');
  const dMissing = decision(missingRef.findings[0], 'PF-008');
  assert.ok(dMissing);
  assert.equal(dMissing.action, 'DOWNGRADED');
  assert.equal(dMissing.afterRisk, 'LOW');
  assert.match(dMissing.reason, /[\u4e00-\u9fff]/);

  const kept = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        category: 'REQUIREMENT_MISMATCH',
        risk_level: 'HIGH',
        title: '验收失败',
        description: '违反验收：必须返回 0',
        evidence: 'return 1',
        requirement_reference: 'REQ-01',
        line_start: 3,
        line_end: 3
      })
    ],
    selectedFiles: [selected()],
    sourceMode: 'FULL_DIRECTORY'
  });
  assert.ok(['MEDIUM', 'HIGH'].includes(kept.findings[0].finalRisk));
  const dKept = decision(kept.findings[0], 'PF-008');
  assert.ok(!dKept || dKept.action !== 'DOWNGRADED');
});

test('PF-009 merges duplicate findings by path, overlap, category, and title fingerprint', () => {
  const result = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        category: 'CORRECTNESS',
        risk_level: 'MEDIUM',
        title: '空 指针 解引用',
        description: '主项描述',
        evidence: 'p->x',
        line_start: 2,
        line_end: 4
      }),
      rawFinding({
        category: 'CORRECTNESS',
        risk_level: 'HIGH',
        title: '空指针解引用',
        description: '重复项描述',
        evidence: 'p->y',
        line_start: 3,
        line_end: 5
      })
    ],
    selectedFiles: [selected('src/a.cpp', [2, 3, 4, 5], 10)],
    sourceMode: 'FULL_DIRECTORY'
  });

  const primary = result.findings[0];
  const merged = result.findings[1];
  assert.notEqual(primary.status, 'MERGED');
  assert.equal(merged.status, 'MERGED');
  assert.equal(merged.findingId, 'F-002');
  assert.equal(primary.finalRisk, 'HIGH');
  const d = decision(merged, 'PF-009');
  assert.ok(d);
  assert.equal(d.action, 'MERGED');
  assert.match(d.reason, /[\u4e00-\u9fff]/);
  const primaryPf009 = decision(primary, 'PF-009');
  assert.ok(primaryPf009, 'primary risk bump must leave a PF-009 audit decision');
  assert.equal(primaryPf009.beforeRisk, 'MEDIUM');
  assert.equal(primaryPf009.afterRisk, 'HIGH');
  assert.match(primaryPf009.reason, /[\u4e00-\u9fff]/);
});

test('PF-009 primary risk bump re-applies legality caps (does not undo PF-008)', () => {
  const result = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        category: 'REQUIREMENT_MISMATCH',
        risk_level: 'HIGH',
        title: '需求不符重复',
        description: '主项缺少需求引用',
        evidence: 'return 1',
        requirement_reference: '',
        line_start: 2,
        line_end: 4
      }),
      rawFinding({
        category: 'REQUIREMENT_MISMATCH',
        risk_level: 'HIGH',
        title: '需求不符重复',
        description: '从项有需求引用',
        evidence: 'return 2',
        requirement_reference: 'REQ-01',
        line_start: 3,
        line_end: 5
      })
    ],
    selectedFiles: [selected('src/a.cpp', [2, 3, 4, 5], 10)],
    sourceMode: 'FULL_DIRECTORY'
  });

  const primary = result.findings[0];
  const merged = result.findings[1];
  assert.equal(merged.status, 'MERGED');
  assert.equal(primary.finalRisk, 'LOW', 'merge must not leave primary above legal PF-008 cap');
  assert.ok(primary.decisions.some((d) => d.policyId === 'PF-009'));
  assert.ok(primary.decisions.some((d) => d.policyId === 'PF-008' && d.action === 'DOWNGRADED'));
});

test('PF-010 recomputes overallRisk from active findings only', () => {
  const mixed = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        category: 'CORRECTNESS',
        risk_level: 'HIGH',
        title: '逻辑错误 A',
        description: '确定的逻辑错误',
        evidence: 'return 1',
        line_start: 3,
        line_end: 3
      }),
      rawFinding({
        file_path: 'src/other.cpp',
        line_start: 1,
        line_end: 1,
        risk_level: 'CRITICAL',
        title: '范围外'
      }),
      rawFinding({
        category: 'CORRECTNESS',
        risk_level: 'MEDIUM',
        title: '逻辑错误 A',
        description: '重复',
        evidence: 'return 2',
        line_start: 3,
        line_end: 3
      })
    ],
    selectedFiles: [selected('src/a.cpp', [3], 10)],
    sourceMode: 'FULL_DIRECTORY'
  });

  assert.equal(mixed.overallRisk, 'HIGH');
  assert.equal(mixed.exemptedFindingCount, 1);
  assert.equal(mixed.mergedFindingCount, 1);
  assert.equal(mixed.activeFindingCount, 1);

  const allExempt = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({ file_path: 'src/out.cpp', line_start: 1, line_end: 1, risk_level: 'CRITICAL' })
    ],
    selectedFiles: [selected('src/a.cpp', [3], 10)],
    sourceMode: 'FULL_DIRECTORY'
  });
  assert.equal(allExempt.overallRisk, 'LOW');
  assert.equal(allExempt.activeFindingCount, 0);
  assert.equal(allExempt.exemptedFindingCount, 1);
  assert.equal(allExempt.mergedFindingCount, 0);
});

test('normalizeFinding injects source ai and null analyzerId/ruleId for AI findings', () => {
  const result = applyPostReviewPolicy({
    rawFindings: [rawFinding({ line_start: 3, line_end: 3 })],
    selectedFiles: [selected('src/a.cpp', [3], 10)],
    sourceMode: 'FULL_DIRECTORY'
  });

  const f = result.findings[0];
  assert.equal(f.source, 'ai');
  assert.equal(f.analyzerId, null);
  assert.equal(f.ruleId, null);
});

test('normalizeFinding preserves analyzer source, analyzerId, and ruleId', () => {
  const result = applyPostReviewPolicy({
    rawFindings: [
      analyzerRawFinding({
        line_start: 3,
        line_end: 3,
        title: 'unused variable',
        description: 'variable x is unused'
      })
    ],
    selectedFiles: [selected('src/a.cpp', [3], 10)],
    sourceMode: 'FULL_DIRECTORY'
  });

  const f = result.findings[0];
  assert.equal(f.source, 'analyzer');
  assert.equal(f.analyzerId, 'clang-tidy');
  assert.equal(f.ruleId, 'misc-unused');
});

test('PF-009 merges cross-source findings with same file, line, category, and ruleId', () => {
  const result = applyPostReviewPolicy({
    rawFindings: [
      rawFinding({
        title: 'AI unused variable',
        description: 'x is unused',
        line_start: 3,
        line_end: 3,
        ruleId: 'misc-unused'
      }),
      analyzerRawFinding({
        title: 'clang-tidy unused variable',
        description: 'warning: unused variable x',
        line_start: 3,
        line_end: 3,
        ruleId: 'misc-unused'
      })
    ],
    selectedFiles: [selected('src/a.cpp', [3], 10)],
    sourceMode: 'FULL_DIRECTORY'
  });

  assert.equal(result.activeFindingCount, 1);
  assert.equal(result.mergedFindingCount, 1);
  assert.equal(result.findings[1].status, 'MERGED');
});

test('PF-009 does not merge findings at same location with different ruleId', () => {
  const result = applyPostReviewPolicy({
    rawFindings: [
      analyzerRawFinding({
        title: 'unused variable',
        line_start: 3,
        line_end: 3,
        ruleId: 'misc-unused'
      }),
      analyzerRawFinding({
        title: 'different check',
        line_start: 3,
        line_end: 3,
        ruleId: 'bugprone-use-after-move',
        description: 'use after move detected'
      })
    ],
    selectedFiles: [selected('src/a.cpp', [3], 10)],
    sourceMode: 'FULL_DIRECTORY'
  });

  assert.equal(result.activeFindingCount, 2);
  assert.equal(result.mergedFindingCount, 0);
});

test('exempt policies still apply to analyzer findings', () => {
  const result = applyPostReviewPolicy({
    rawFindings: [
      analyzerRawFinding({
        file_path: 'src/other.cpp',
        line_start: 1,
        line_end: 1
      })
    ],
    selectedFiles: [selected('src/a.cpp', [3], 10)],
    sourceMode: 'FULL_DIRECTORY'
  });

  const f = result.findings[0];
  assert.equal(f.source, 'analyzer');
  assert.equal(f.status, 'EXEMPTED');
  const d = decision(f, 'PF-002');
  assert.ok(d);
  assert.equal(d.action, 'EXEMPTED');
});
