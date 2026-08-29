import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { resolveRealPath, assertInsideAllowedRoots, toPosixRelative } from '../src/shared/path-security.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

test('assertInsideAllowedRoots allows a realpath under an allowed root', async () => {
  const root = await makeTempDir();
  const project = path.join(root, 'workspaces', 'demo');
  await fs.mkdir(project, { recursive: true });
  const realProject = await resolveRealPath(project);
  const realRoot = await resolveRealPath(path.join(root, 'workspaces'));
  assert.doesNotThrow(() => assertInsideAllowedRoots(realProject, [realRoot]));
});

test('assertInsideAllowedRoots rejects a sibling that only shares a string prefix', async () => {
  const root = await makeTempDir();
  const allowed = path.join(root, 'work');
  const escapee = path.join(root, 'work-evil', 'p');
  await fs.mkdir(allowed, { recursive: true });
  await fs.mkdir(escapee, { recursive: true });
  const realAllowed = await resolveRealPath(allowed);
  const realEscapee = await resolveRealPath(escapee);
  assert.throws(
    () => assertInsideAllowedRoots(realEscapee, [realAllowed]),
    (err) => err.code === ErrorCodes.PATH_OUTSIDE_ALLOWED_ROOT
  );
});

test('toPosixRelative returns forward-slash paths', async () => {
  const root = await makeTempDir();
  const file = path.join(root, 'src', 'a.cpp');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'int x;\n', 'utf8');
  const rel = toPosixRelative(await resolveRealPath(root), await resolveRealPath(file));
  assert.equal(rel, 'src/a.cpp');
});

test('assertInsideAllowedRoots rejects empty allowedRoots with INVALID_REQUEST', async () => {
  const root = await makeTempDir();
  const realPath = await resolveRealPath(root);
  assert.throws(
    () => assertInsideAllowedRoots(realPath, []),
    (err) => err.code === ErrorCodes.INVALID_REQUEST
  );
});

test('resolveRealPath throws PATH_NOT_FOUND for a missing path', async () => {
  const root = await makeTempDir();
  const missing = path.join(root, 'does-not-exist');
  await assert.rejects(
    () => resolveRealPath(missing),
    (err) => err.code === ErrorCodes.PATH_NOT_FOUND
  );
});

test('assertInsideAllowedRoots uses PATH_SYMLINK_ESCAPE when lexical path is inside but realpath is outside', async () => {
  const root = await makeTempDir();
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  await fs.mkdir(allowed, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  const realAllowed = await resolveRealPath(allowed);
  const realOutside = await resolveRealPath(outside);
  const lexicalLink = path.join(allowed, 'escape');
  assert.throws(
    () => assertInsideAllowedRoots(realOutside, [realAllowed], lexicalLink),
    (err) => err.code === ErrorCodes.PATH_SYMLINK_ESCAPE
  );
});

test('symlink whose realpath leaves allowedRoots is PATH_SYMLINK_ESCAPE', async (t) => {
  const root = await makeTempDir();
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  await fs.mkdir(allowed, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  const link = path.join(allowed, 'escape');
  try {
    await fs.symlink(outside, link, 'dir');
  } catch {
    t.skip('symlink not permitted on this machine');
    return;
  }
  const realLink = await resolveRealPath(link);
  const realAllowed = await resolveRealPath(allowed);
  assert.throws(
    () => assertInsideAllowedRoots(realLink, [realAllowed], link),
    (err) => err.code === ErrorCodes.PATH_SYMLINK_ESCAPE
  );
});
