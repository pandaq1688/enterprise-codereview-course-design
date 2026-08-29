import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { languageFromFileName, shouldSkipDirName } from './shared/source-extensions.js';
import { sha256Text } from './shared/hash.js';
import { toPosixRelative } from './shared/path-security.js';
import { numberLines } from './shared/source-text.js';
import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';

const execFile = promisify(execFileCb);

export { numberLines };

/**
 * @param {string} text
 * @returns {number}
 */
function lineCountOf(text) {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  if (text.endsWith('\n')) count--;
  return count;
}

/**
 * @param {number} n
 * @returns {number[]}
 */
function range1To(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(i);
  return out;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function gitRead(cwd, args) {
  const { stdout } = await execFile('git', args, {
    cwd,
    windowsHide: true,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8'
  });
  return stdout;
}

/**
 * Parse `git diff -U0` hunk headers and collect new-file (+) line numbers.
 * @param {string} diffText
 * @returns {number[]}
 */
export function parseChangedLinesFromUnifiedDiff(diffText) {
  const changed = [];
  let newLine = 0;
  const hunkRe = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;
  for (const raw of diffText.split('\n')) {
    const hunk = hunkRe.exec(raw);
    if (hunk) {
      newLine = Number(hunk[3]);
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      continue;
    }
    if (raw.startsWith('+')) {
      changed.push(newLine);
      newLine += 1;
    } else if (raw.startsWith('-')) {
      // deletion on old side only
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
    } else if (raw.startsWith(' ')) {
      newLine += 1;
    }
  }
  return changed;
}

/**
 * @param {string} statusCode
 * @returns {'ADDED'|'MODIFIED'|'DELETED'|'RENAMED'|null}
 */
function mapGitStatus(statusCode) {
  const code = statusCode[0];
  if (code === 'A') return 'ADDED';
  if (code === 'M') return 'MODIFIED';
  if (code === 'D') return 'DELETED';
  if (code === 'R') return 'RENAMED';
  if (code === 'T') return 'MODIFIED';
  if (code === 'C') return 'ADDED';
  return null;
}

/**
 * @param {string} nameStatusZ
 * @returns {{ status: string, path: string, oldPath: string|null }[]}
 */
function parseNameStatusZ(nameStatusZ) {
  const parts = nameStatusZ.split('\0').filter((p) => p.length > 0);
  const entries = [];
  let i = 0;
  while (i < parts.length) {
    const statusCode = parts[i];
    i += 1;
    const mapped = mapGitStatus(statusCode);
    if (!mapped) {
      // Unknown status: skip path(s)
      if (statusCode[0] === 'R' || statusCode[0] === 'C') i += 2;
      else i += 1;
      continue;
    }
    if (mapped === 'RENAMED' || statusCode[0] === 'C') {
      const oldPath = parts[i];
      const newPath = parts[i + 1];
      i += 2;
      entries.push({ status: mapped === 'RENAMED' ? 'RENAMED' : mapped, path: newPath, oldPath });
    } else {
      const filePath = parts[i];
      i += 1;
      entries.push({ status: mapped, path: filePath, oldPath: null });
    }
  }
  return entries;
}

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listSupportedFilesRecursive(root) {
  /** @type {string[]} */
  const results = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (shouldSkipDirName(ent.name)) continue;
        await walk(abs);
      } else if (ent.isFile()) {
        if (languageFromFileName(ent.name) == null) continue;
        results.push(toPosixRelative(root, abs));
      }
    }
  }

  await walk(root);
  return results;
}

/**
 * @param {{ projectDir: string, maxFiles: number, maxFileChars: number, maxInputChars: number }} opts
 * @returns {Promise<{ files: object[], contents: Record<string, string>, totalCharacters: number }>}
 */
export async function collectGitChangedSource({ projectDir, maxFiles, maxFileChars, maxInputChars }) {
  let inside;
  try {
    inside = (await gitRead(projectDir, ['rev-parse', '--is-inside-work-tree'])).trim();
  } catch {
    throw new AppError(ErrorCodes.GIT_REPOSITORY_REQUIRED, '当前项目不是 Git 工作区', [projectDir]);
  }
  if (inside !== 'true') {
    throw new AppError(ErrorCodes.GIT_REPOSITORY_REQUIRED, '当前项目不是 Git 工作区', [projectDir]);
  }

  let hasHead = true;
  try {
    await gitRead(projectDir, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    hasHead = false;
  }

  /** @type {{ status: string, path: string, oldPath: string|null }[]} */
  let candidates;

  if (!hasHead) {
    const paths = await listSupportedFilesRecursive(projectDir);
    candidates = paths.map((p) => ({ status: 'ADDED', path: p, oldPath: null }));
  } else {
    const nameStatus = await gitRead(projectDir, ['diff', '--name-status', '-z', 'HEAD']);
    const tracked = parseNameStatusZ(nameStatus);
    const untrackedZ = await gitRead(projectDir, ['ls-files', '-z', '--others', '--exclude-standard']);
    const untrackedPaths = untrackedZ.split('\0').filter((p) => p.length > 0);
    const trackedPaths = new Set(tracked.map((t) => t.path));
    candidates = [...tracked];
    for (const p of untrackedPaths) {
      if (trackedPaths.has(p)) continue;
      candidates.push({ status: 'UNTRACKED', path: p, oldPath: null });
    }
  }

  const filtered = candidates.filter((c) => languageFromFileName(path.basename(c.path)) != null);
  if (filtered.length === 0) {
    throw new AppError(ErrorCodes.NO_REVIEWABLE_SOURCE, '没有可审查的源代码变更', []);
  }
  if (filtered.length > maxFiles) {
    throw new AppError(
      ErrorCodes.SOURCE_FILE_LIMIT_EXCEEDED,
      '变更文件数超过上限',
      [`files=${filtered.length}`, `maxFiles=${maxFiles}`]
    );
  }

  filtered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  /** @type {object[]} */
  const files = [];
  /** @type {Record<string, string>} */
  const contents = {};
  /** @type {string[]} */
  const sizeDetails = [];
  let totalCharacters = 0;

  for (const entry of filtered) {
    const language = languageFromFileName(path.basename(entry.path));
    if (entry.status === 'DELETED') {
      const diffText = await gitRead(projectDir, ['diff', 'HEAD', '--', entry.path]);
      if (diffText.length > maxFileChars) {
        sizeDetails.push(`${entry.path}:chars=${diffText.length}`);
      }
      totalCharacters += diffText.length;
      contents[entry.path] = diffText;
      files.push({
        path: entry.path,
        language,
        status: 'DELETED',
        contentHash: sha256Text(''),
        changedLines: [],
        lineCount: null,
        oldPath: null
      });
      continue;
    }

    const abs = path.join(projectDir, ...entry.path.split('/'));
    const raw = await fs.readFile(abs, 'utf8');
    const numbered = numberLines(raw);
    if (numbered.length > maxFileChars) {
      sizeDetails.push(`${entry.path}:chars=${numbered.length}`);
    }
    totalCharacters += numbered.length;
    contents[entry.path] = numbered;

    const lineCount = lineCountOf(raw);
    let changedLines;
    if (entry.status === 'ADDED' || entry.status === 'UNTRACKED') {
      changedLines = range1To(lineCount);
    } else {
      const zeroDiff = await gitRead(projectDir, ['diff', '-U0', 'HEAD', '--', entry.path]);
      changedLines = parseChangedLinesFromUnifiedDiff(zeroDiff);
    }

    files.push({
      path: entry.path,
      language,
      status: entry.status,
      contentHash: sha256Text(raw),
      changedLines,
      lineCount,
      oldPath: entry.status === 'RENAMED' ? entry.oldPath : null
    });
  }

  if (sizeDetails.length > 0) {
    throw new AppError(ErrorCodes.SOURCE_SIZE_LIMIT_EXCEEDED, '单个文件超过大小上限', sizeDetails);
  }
  if (totalCharacters > maxInputChars) {
    throw new AppError(
      ErrorCodes.SOURCE_SIZE_LIMIT_EXCEEDED,
      '输入总字符数超过上限',
      [`totalCharacters=${totalCharacters}`, `maxInputChars=${maxInputChars}`]
    );
  }

  return { files, contents, totalCharacters };
}
