import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRules } from '../src/rule-resolver.js';

const rulesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'rules');

test('always loads global rules and language rules only when those files exist in the input', async () => {
  const resolved = await resolveRules({
    projectDir: '/proj',
    files: [
      { path: 'src/a.cpp', language: 'CPP' },
      { path: 'src/B.java', language: 'JAVA' }
    ],
    checklist: { enabled: false, path: null, includePaths: ['.'], excludePaths: [] },
    rulesDir
  });
  const types = resolved.rules.map((r) => r.ruleType).sort();
  assert.deepEqual(types, ['CPP', 'GLOBAL', 'JAVA']);
  assert.equal(resolved.rules.find((r) => r.ruleType === 'GLOBAL').builtIn, true);
  assert.ok(resolved.rules.find((r) => r.ruleType === 'CPP').matchedFiles.includes('src/a.cpp'));
});

test('loads checklist only for includePaths minus excludePaths', async () => {
  const resolved = await resolveRules({
    projectDir: '/proj',
    files: [
      { path: 'src/a.cpp', language: 'CPP' },
      { path: 'src/generated/x.cpp', language: 'CPP' }
    ],
    checklist: {
      enabled: true,
      path: path.join(rulesDir, 'review-checklist.md'),
      includePaths: ['src'],
      excludePaths: ['src/generated']
    },
    rulesDir
  });
  const cl = resolved.rules.find((r) => r.ruleType === 'CHECKLIST');
  assert.equal(cl.builtIn, false);
  assert.deepEqual(cl.matchedFiles, ['src/a.cpp']);
});

test('does not load checklist when disabled', async () => {
  const resolved = await resolveRules({
    projectDir: '/proj',
    files: [{ path: 'src/a.cpp', language: 'CPP' }],
    checklist: { enabled: false, path: path.join(rulesDir, 'review-checklist.md'), includePaths: ['.'], excludePaths: [] },
    rulesDir
  });
  assert.equal(resolved.rules.some((r) => r.ruleType === 'CHECKLIST'), false);
});
