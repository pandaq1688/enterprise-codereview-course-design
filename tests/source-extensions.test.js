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
  assert.equal(languageFromFileName('app.js'), 'JS');
  assert.equal(languageFromFileName('module.MJS'), 'JS');
  assert.equal(languageFromFileName('config.CJS'), 'JS');
  assert.equal(languageFromFileName('main.py'), 'PYTHON');
  assert.equal(languageFromFileName('Util.PY'), 'PYTHON');
  assert.equal(languageFromFileName('main.go'), 'GO');
  assert.equal(languageFromFileName('Svc.GO'), 'GO');
  assert.equal(languageFromFileName('readme.md'), null);
  assert.equal(languageFromFileName('Makefile'), null);
});

test('shouldSkipDirName matches the fixed exclusion list', () => {
  assert.equal(shouldSkipDirName('node_modules'), true);
  assert.equal(shouldSkipDirName('target'), true);
  assert.equal(shouldSkipDirName('reports'), true);
  assert.equal(shouldSkipDirName('tests'), true);
  assert.equal(shouldSkipDirName('scripts'), true);
  assert.equal(shouldSkipDirName('examples'), true);
  assert.equal(shouldSkipDirName('.superpowers'), true);
  assert.equal(shouldSkipDirName('superpowers'), true);
  assert.equal(shouldSkipDirName('.sdd'), true);
  assert.equal(shouldSkipDirName('.cursor'), true);
  assert.equal(shouldSkipDirName('.worktrees'), true);
  assert.equal(shouldSkipDirName('tmp'), true);
  assert.equal(shouldSkipDirName('temp'), true);
  assert.equal(shouldSkipDirName('src'), false);
  assert.equal(shouldSkipDirName('docs'), false);
});

test('isBinaryBuffer detects NUL bytes', () => {
  assert.equal(isBinaryBuffer(Buffer.from('int x;\n')), false);
  assert.equal(isBinaryBuffer(Buffer.from([0x00, 0x01, 0x02])), true);
});
