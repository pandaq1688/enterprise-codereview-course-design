#!/usr/bin/env node
/**
 * Bridge: code-review-system Cursor provider contract → modern `agent` CLI.
 *
 * Args:
 *   --prompt-file <path>
 *   --workspace <path>
 *   --output <path>
 *
 * Spawns the installed agent Node entrypoint directly (avoids Windows .cmd
 * spawn EINVAL). Passes a short wrapper prompt that points at the full
 * prompt file to avoid Windows argv length limits.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

function parseVersionKey(name) {
  const datePart = String(name).split('-')[0];
  const parts = datePart.split('.');
  if (parts.length !== 3) return 0;
  return Number(
    `${parts[0]}${parts[1].padStart(2, '0')}${parts[2].padStart(2, '0')}`
  );
}

function resolveAgentEntry() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'cursor-agent');
  const versionsRoot = path.join(base, 'versions');
  if (!fs.existsSync(versionsRoot)) {
    throw new Error(`cursor-agent versions not found at ${versionsRoot}`);
  }
  const dirs = fs
    .readdirSync(versionsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(name))
    .sort((a, b) => parseVersionKey(b) - parseVersionKey(a));
  if (dirs.length === 0) {
    throw new Error(`no cursor-agent version directories under ${versionsRoot}`);
  }
  const versionDir = path.join(versionsRoot, dirs[0]);
  const nodePath = path.join(versionDir, 'node.exe');
  const indexPath = path.join(versionDir, 'index.js');
  if (!fs.existsSync(nodePath) || !fs.existsSync(indexPath)) {
    throw new Error(`agent entry missing under ${versionDir}`);
  }
  return { nodePath, indexPath, versionDir };
}

const promptFile = argValue('--prompt-file');
const workspace = argValue('--workspace');
const outputFile = argValue('--output');

if (!promptFile || !workspace || !outputFile) {
  console.error('Usage: node cursor-agent-bridge.mjs --prompt-file P --workspace W --output O');
  process.exit(2);
}

const absPrompt = path.resolve(promptFile);
const absWorkspace = path.resolve(workspace);
const absOutput = path.resolve(outputFile);
if (!fs.existsSync(absPrompt)) {
  console.error(`prompt file not found: ${absPrompt}`);
  process.exit(2);
}

const { nodePath, indexPath } = resolveAgentEntry();

const wrapperPrompt = [
  'You are running as a headless code-review backend.',
  `Read the complete review instructions from this UTF-8 file and follow them exactly:`,
  absPrompt,
  '',
  'Your final answer must be ONLY the JSON object required by that file.',
  'Do not wrap it in Markdown fences.',
  'Do not modify any source files.',
  'Do not ask questions.'
].join(os.EOL);

const child = spawn(
  nodePath,
  [
    indexPath,
    '-p',
    '--mode',
    'ask',
    '--trust',
    '--workspace',
    absWorkspace,
    '--output-format',
    'text',
    wrapperPrompt
  ],
  {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_COMPILE_CACHE:
        process.env.NODE_COMPILE_CACHE ||
        path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'cursor-compile-cache')
    }
  }
);

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (c) => {
  stdout += c;
});
child.stderr.on('data', (c) => {
  stderr += c;
});

child.on('error', (err) => {
  console.error(err.message);
  process.exit(1);
});

child.on('close', (code) => {
  const body = stdout.trim() || stderr.trim();
  fs.mkdirSync(path.dirname(absOutput), { recursive: true });
  fs.writeFileSync(absOutput, body, 'utf8');
  if (stderr.trim()) {
    process.stderr.write(stderr);
  }
  process.exit(code === null ? 1 : code);
});
