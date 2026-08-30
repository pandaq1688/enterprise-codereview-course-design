import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTempDir } from './temp-workspace.js';
import { git, writeFile } from './temp-git-repo.js';
import { makeBareRepo } from './temp-bare-repo.js';
import { resolveRealPath } from '../../src/shared/path-security.js';
import { createFakeReviewProvider } from './fake-review-provider.js';

export const FAKE_OK_JSON = JSON.stringify({
  summary: 'E2E fake review ok',
  overall_risk: 'LOW',
  findings: [],
  evidence: [],
  recommended_actions: []
});

/** Unique marker for AC-03 checklist prompt assertions */
export const CHECKLIST_MARKER = 'E2E_CHECKLIST_MARKER_AC03_UNIQUE';

/**
 * @param {{ allowedRoot: string, reportsDir: string, extras?: object }} opts
 */
export function createE2eConfig({ allowedRoot, reportsDir, extras = {} }) {
  const { checklist, server, ...rest } = extras;
  return {
    security: { allowedRoots: [allowedRoot] },
    server: server ?? { host: '127.0.0.1', port: 0 },
    reports: { dir: reportsDir, includeAbsolutePaths: false },
    checklist: checklist ?? {
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
    },
    cursor: {
      command: 'cursor-agent',
      args: [],
      timeoutMs: 60000,
      maxOutputChars: 2000000
    },
    ai: { provider: 'fake' },
    ...rest
  };
}

/**
 * Fake provider that records promptFile contents for E2E assertions.
 * @param {{ rawOutput: string, exitCode?: number, delayMs?: number, writeOutputFile?: boolean }} options
 */
export function createRecordingFakeProvider(options) {
  const base = createFakeReviewProvider(options);
  /** @type {Array<{ promptFile?: string, outputFile?: string, promptText: string }>} */
  const calls = [];

  return {
    calls,
    async review(args) {
      let promptText = '';
      if (args?.promptFile) {
        promptText = await fs.readFile(args.promptFile, 'utf8');
      }
      calls.push({
        promptFile: args?.promptFile,
        outputFile: args?.outputFile,
        promptText
      });
      return base.review(args);
    }
  };
}

async function makeAllowedWorkspace(prefix) {
  const allowedRoot = await makeTempDir(prefix);
  const reportsDir = path.join(allowedRoot, '_reports');
  await fs.mkdir(reportsDir, { recursive: true });
  return { allowedRoot, reportsDir };
}

async function writeRequirement(dir, rel = 'docs/requirement.md') {
  const abs = path.join(dir, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, '# 需求\nE2E 验收用需求文档\n', 'utf8');
  return abs;
}

/**
 * Temporary Git repo under allowedRoots: staged / unstaged / untracked cpp + requirement.
 */
export async function createGitChangesFixture() {
  const { allowedRoot, reportsDir } = await makeAllowedWorkspace('crs-e2e-git-');
  const nested = path.join(allowedRoot, 'repo');
  await fs.mkdir(nested, { recursive: true });
  await git(nested, ['init']);
  await git(nested, ['config', 'user.email', 'test@example.com']);
  await git(nested, ['config', 'user.name', 'Test']);

  await writeFile(nested, 'src/base.cpp', 'int a = 1;\n');
  await git(nested, ['add', 'src/base.cpp']);
  await git(nested, ['commit', '-m', 'base']);

  await writeFile(nested, 'src/staged.cpp', 'int s = 1;\n');
  await git(nested, ['add', 'src/staged.cpp']);

  await writeFile(nested, 'src/base.cpp', 'int a = 2;\n');
  await writeFile(nested, 'src/untracked.cpp', 'int u = 1;\n');

  const requirementFile = await writeRequirement(nested);
  return { allowedRoot, reportsDir, projectDir: nested, requirementFile };
}

/**
 * Full-directory fixture: cpp + java + unsupported md under allowedRoots.
 */
export async function createFullDirectoryFixture() {
  const { allowedRoot, reportsDir } = await makeAllowedWorkspace('crs-e2e-full-');
  const projectDir = path.join(allowedRoot, 'proj');
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'src', 'a.cpp'), 'int x = 1;\n', 'utf8');
  await fs.writeFile(path.join(projectDir, 'src', 'A.java'), 'class A {}\n', 'utf8');
  await fs.writeFile(path.join(projectDir, 'note.md'), '# note should not be collected\n', 'utf8');
  const requirementFile = await writeRequirement(projectDir);
  return { allowedRoot, reportsDir, projectDir, requirementFile };
}

/**
 * Checklist fixture: src/a.cpp + src/generated/x.cpp + custom checklist under allowedRoots.
 */
export async function createChecklistFixture() {
  const { allowedRoot, reportsDir } = await makeAllowedWorkspace('crs-e2e-cl-');
  const projectDir = path.join(allowedRoot, 'proj');
  await fs.mkdir(path.join(projectDir, 'src', 'generated'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'src', 'a.cpp'), 'int a = 1;\n', 'utf8');
  await fs.writeFile(path.join(projectDir, 'src', 'generated', 'x.cpp'), 'int x = 1;\n', 'utf8');
  const checklistFile = path.join(allowedRoot, 'custom-checklist.md');
  await fs.writeFile(
    checklistFile,
    `# Custom Checklist\n\n${CHECKLIST_MARKER}\n\n- item one\n`,
    'utf8'
  );
  const requirementFile = await writeRequirement(projectDir);
  return { allowedRoot, reportsDir, projectDir, requirementFile, checklistFile };
}

/**
 * Paths for AC-04: allowed root project + outside project.
 */
export async function createPathOutsideFixture() {
  const { allowedRoot, reportsDir } = await makeAllowedWorkspace('crs-e2e-sec-');
  const insideProject = path.join(allowedRoot, 'inside');
  await fs.mkdir(insideProject, { recursive: true });
  await fs.writeFile(path.join(insideProject, 'a.cpp'), 'int a = 1;\n', 'utf8');
  await writeRequirement(insideProject);

  const outsideRoot = await makeTempDir('crs-e2e-out-');
  const outsideProjectDir = path.join(outsideRoot, 'outside-proj');
  await fs.mkdir(outsideProjectDir, { recursive: true });
  await fs.writeFile(path.join(outsideProjectDir, 'a.cpp'), 'int a = 1;\n', 'utf8');
  const outsideRequirementFile = await writeRequirement(outsideProjectDir);

  return {
    allowedRoot,
    reportsDir,
    insideProject,
    outsideProjectDir,
    outsideRequirementFile
  };
}

/**
 * Realpath of the OS temp dir — needed as an allowedRoot when the remote Git
 * fetcher runs in ephemeral mode (it mkdtemp's under os.tmpdir() and then
 * asserts the result is inside allowedRoots).
 */
export async function realTempDir() {
  return resolveRealPath(os.tmpdir());
}

/**
 * AC-10 fixture: a local bare repo (acts as the remote) plus an allowed root
 * that holds the requirement file. The fetcher runs in ephemeral mode so the
 * cloned workspace lands under os.tmpdir(); callers must add realTempDir() to
 * allowedRoots alongside the returned allowedRoot.
 */
export async function createRemoteGitFixture() {
  const { bare, headRef } = await makeBareRepo();
  const { allowedRoot, reportsDir } = await makeAllowedWorkspace('crs-e2e-remote-');
  const projectDir = path.join(allowedRoot, 'placeholder');
  await fs.mkdir(projectDir, { recursive: true });
  const requirementFile = await writeRequirement(projectDir);
  return { allowedRoot, reportsDir, bare, headRef, requirementFile };
}

/**
 * AC-11 fake analyzer. Emits findings shaped like the real clang-tidy analyzer
 * so the e2e path exercises the analyzer→PostReviewPolicy integration.
 *
 * @param {{ findings?: object[], throwOnce?: boolean }} [opts]
 */
export function createFakeAnalyzer(opts = {}) {
  const findings = opts.findings ?? [];
  let thrown = false;
  return {
    async analyze({ files }) {
      if (opts.throwOnce && !thrown) {
        thrown = true;
        const { AppError } = await import('../../src/shared/app-error.js');
        const { ErrorCodes } = await import('../../src/shared/error-codes.js');
        throw new AppError(ErrorCodes.ANALYZER_FAILED, 'fake analyzer boom', ['fake.c']);
      }
      // Allow findings to be a function of the collected files for flexibility.
      if (typeof findings === 'function') return findings(files);
      return findings;
    }
  };
}

/**
 * AC-12 fixture: a project with `fileCount` cpp files, each a single line of
 * `charsPerFile` characters, so total characters and per-file characters are
 * predictable for shard planning.
 */
export async function createShardFixture({ fileCount, charsPerFile }) {
  const { allowedRoot, reportsDir } = await makeAllowedWorkspace('crs-e2e-shard-');
  const projectDir = path.join(allowedRoot, 'proj');
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
  const content = 'x'.repeat(Math.max(1, charsPerFile));
  for (let i = 0; i < fileCount; i++) {
    await fs.writeFile(path.join(projectDir, 'src', `f${i}.cpp`), content + '\n', 'utf8');
  }
  const requirementFile = await writeRequirement(projectDir);
  return { allowedRoot, reportsDir, projectDir, requirementFile };
}

/**
 * AC-12 fake review provider that counts review calls, tracks max in-flight
 * concurrency, and returns one finding per shard referencing the shard's
 * first file so aggregated findings are distinguishable.
 *
 * @param {{ riskLevel?: string }} [opts]
 */
export function createShardCountingProvider(opts = {}) {
  const riskLevel = opts.riskLevel ?? 'LOW';
  /** @type {Array<{ files: object[], callIndex: number }>} */
  const calls = [];
  let inFlight = 0;
  let maxConcurrency = 0;
  let callIndex = 0;

  return {
    calls,
    maxConcurrency: () => maxConcurrency,
    async review(args) {
      const myIndex = callIndex++;
      calls.push({ files: args?.files ?? [], callIndex: myIndex });
      inFlight += 1;
      if (inFlight > maxConcurrency) maxConcurrency = inFlight;
      // Simulate tiny async yield so concurrency>1 can actually overlap.
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      const firstFile = args?.files?.[0]?.path ?? 'src/unknown.cpp';
      const rawOutput = JSON.stringify({
        summary: `shard ${myIndex}`,
        overall_risk: riskLevel,
        findings: [
          {
            category: 'CORRECTNESS',
            risk_level: riskLevel,
            title: `shard-finding-${myIndex}`,
            description: `finding from shard ${myIndex}`,
            file_path: firstFile,
            line_start: 1,
            line_end: 1,
            evidence: 'int x = 1',
            requirement_reference: '',
            fix_suggestion: '',
            fix_code: ''
          }
        ],
        evidence: [],
        recommended_actions: []
      });
      return {
        rawOutput,
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        providerMetadata: { fake: true, shard: myIndex }
      };
    }
  };
}
