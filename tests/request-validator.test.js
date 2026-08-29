import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { makeGitRepo } from './helpers/temp-git-repo.js';
import { validateCreateReviewRequest } from '../src/request-validator.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

async function makeAllowedRoot() {
  return makeTempDir('crs-allowed-');
}

function configWithRoot(root) {
  return {
    security: { allowedRoots: [root] },
    checklist: {
      enabled: false,
      path: null,
      includePaths: ['.'],
      excludePaths: []
    },
    review: {
      maxFiles: 50,
      maxFileChars: 80000,
      maxInputChars: 240000,
      maxRequirementChars: 50000
    }
  };
}

async function setupProject(root, { withGit = true } = {}) {
  const projectDir = withGit
    ? await makeGitRepo()
    : await makeTempDir('crs-proj-');
  // place project under allowed root via rename/move isn't portable; instead
  // nest under root by creating inside root
  const nested = path.join(root, 'workspaces', 'demo');
  await fs.mkdir(path.dirname(nested), { recursive: true });
  // copy/move: recreate under nested
  await fs.rm(nested, { recursive: true, force: true });
  await fs.rename(projectDir, nested);
  const req = path.join(nested, 'docs', 'requirement.md');
  await fs.mkdir(path.dirname(req), { recursive: true });
  await fs.writeFile(req, '# req\n', 'utf8');
  if (withGit) {
    // ensure .git survived rename; re-init if needed for nested location
    try {
      await fs.access(path.join(nested, '.git'));
    } catch {
      const { git } = await import('./helpers/temp-git-repo.js');
      await git(nested, ['init']);
    }
  }
  return { projectDir: nested, requirementFile: req };
}

test('validateCreateReviewRequest rejects missing projectDir with INVALID_REQUEST', async () => {
  const root = await makeAllowedRoot();
  await assert.rejects(
    () => validateCreateReviewRequest({ requirementFile: 'x', sourceMode: 'FULL_DIRECTORY' }, configWithRoot(root)),
    (err) => err.code === ErrorCodes.INVALID_REQUEST
  );
});

test('validateCreateReviewRequest rejects path outside allowedRoots', async () => {
  const root = await makeAllowedRoot();
  const outside = await makeTempDir('crs-out-');
  const req = path.join(outside, 'req.md');
  await fs.writeFile(req, '# r\n', 'utf8');
  await assert.rejects(
    () => validateCreateReviewRequest({
      projectDir: outside,
      requirementFile: req,
      sourceMode: 'FULL_DIRECTORY'
    }, configWithRoot(root)),
    (err) => err.code === ErrorCodes.PATH_OUTSIDE_ALLOWED_ROOT
  );
});

test('validateCreateReviewRequest rejects GIT_CHANGES when not a git work tree', async () => {
  const root = await makeAllowedRoot();
  const { projectDir, requirementFile } = await setupProject(root, { withGit: false });
  await assert.rejects(
    () => validateCreateReviewRequest({
      projectDir,
      requirementFile,
      sourceMode: 'GIT_CHANGES'
    }, configWithRoot(root)),
    (err) => err.code === ErrorCodes.GIT_REPOSITORY_REQUIRED
  );
});

test('validateCreateReviewRequest rejects illegal sourceMode', async () => {
  const root = await makeAllowedRoot();
  const { projectDir, requirementFile } = await setupProject(root, { withGit: false });
  await assert.rejects(
    () => validateCreateReviewRequest({
      projectDir,
      requirementFile,
      sourceMode: 'WEIRD'
    }, configWithRoot(root)),
    (err) => err.code === ErrorCodes.INVALID_REQUEST
  );
});

test('validateCreateReviewRequest rejects non-markdown checklist with INVALID_REQUEST', async () => {
  const root = await makeAllowedRoot();
  const { projectDir, requirementFile } = await setupProject(root, { withGit: false });
  const checklistPath = path.join(projectDir, 'checklist.txt');
  await fs.writeFile(checklistPath, 'not md', 'utf8');
  await assert.rejects(
    () => validateCreateReviewRequest({
      projectDir,
      requirementFile,
      sourceMode: 'FULL_DIRECTORY',
      checklist: {
        enabled: true,
        path: checklistPath,
        includePaths: ['.'],
        excludePaths: []
      }
    }, configWithRoot(root)),
    (err) =>
      err.code === ErrorCodes.INVALID_REQUEST &&
      err.message === 'checklist 必须是 Markdown 文件'
  );
});

test('validateCreateReviewRequest normalizes paths and display segments', async () => {
  const root = await makeAllowedRoot();
  const { projectDir, requirementFile } = await setupProject(root, { withGit: true });
  const checklistPath = path.join(projectDir, 'review-checklist.md');
  await fs.writeFile(checklistPath, '# cl\n', 'utf8');
  const normalized = await validateCreateReviewRequest({
    projectDir,
    requirementFile,
    sourceMode: 'GIT_CHANGES',
    checklist: {
      enabled: true,
      path: checklistPath,
      includePaths: ['src'],
      excludePaths: []
    }
  }, configWithRoot(root));
  assert.equal(normalized.sourceMode, 'GIT_CHANGES');
  assert.equal(normalized.projectName, 'demo');
  assert.equal(normalized.projectDirDisplay, 'workspaces/demo');
  assert.match(normalized.requirementFileDisplay, /docs\/requirement\.md$/);
  assert.match(normalized.checklistFileDisplay, /demo\/review-checklist\.md$/);
  assert.equal(normalized.checklist.enabled, true);
  assert.ok(normalized.checklist.path);
  assert.deepEqual(normalized.checklist.includePaths, ['src']);
});
