import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  languageFromFileName,
  shouldSkipDirName,
  isBinaryBuffer
} from '../src/shared/source-extensions.js';

test('languageFromFileName maps supported extensions case-insensitively', () => {
  assert.equal(languageFromFileName('a.C'), 'C');
  assert.equal(languageFromFileName('Foo.CPP'), 'CPP');
  assert.equal(languageFromFileName('Bar.Java'), 'JAVA');
  assert.equal(languageFromFileName('readme.md'), null);
  assert.equal(languageFromFileName('Makefile'), null);
});

test('shouldSkipDirName matches the fixed exclusion list', () => {
  assert.equal(shouldSkipDirName('node_modules'), true);
  assert.equal(shouldSkipDirName('target'), true);
  assert.equal(shouldSkipDirName('src'), false);
});

test('isBinaryBuffer detects NUL bytes', () => {
  assert.equal(isBinaryBuffer(Buffer.from('int x;\n')), false);
  assert.equal(isBinaryBuffer(Buffer.from([0x00, 0x01, 0x02])), true);
});
