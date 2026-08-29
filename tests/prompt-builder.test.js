import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/prompt-builder.js';

test('emits sections in the required order and is stable', async () => {
  const input = {
    requirementText: '# 需求\n返回 0\n',
    sourceMode: 'GIT_CHANGES',
    files: [{ path: 'src/a.cpp', language: 'CPP', status: 'MODIFIED' }],
    contents: { 'src/a.cpp': '@@\n+int x;\n' },
    rules: [
      { ruleType: 'GLOBAL', content: '全局规则A' },
      { ruleType: 'CPP', content: 'C++规则B' }
    ]
  };
  const a = buildPrompt(input).text;
  const b = buildPrompt(input).text;
  assert.equal(a, b);
  const idx = [
    '## 角色与证据原则',
    '## JSON 输出契约',
    '## 需求文档',
    '## 审查范围',
    '## 固定全局规则',
    '## 固定语言规则',
    '## review-checklist',
    '## 源码或 Diff',
    '## 输出前自检'
  ].map((h) => a.indexOf(h));
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1]);
  assert.ok(a.includes('全局规则A'));
  assert.ok(a.includes('C++规则B'));
  assert.ok(a.includes('# 需求'));
  assert.ok(a.includes('src/a.cpp'));
});
