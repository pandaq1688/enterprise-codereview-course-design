import fs from 'node:fs/promises';
import path from 'node:path';
import { languageFromFileName, shouldSkipDirName, isBinaryBuffer } from './shared/source-extensions.js';
import { sha256Text } from './shared/hash.js';
import { toPosixRelative } from './shared/path-security.js';
import { numberLines } from './shared/source-text.js';
import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';

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
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listSupportedFilesRecursive(root) {
  /** @type {string[]} */
  const results = [];

  async function walk(dir) {
    const names = await fs.readdir(dir);
    for (const name of names) {
      const abs = path.join(dir, name);
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (shouldSkipDirName(name)) continue;
        await walk(abs);
      } else if (st.isFile()) {
        if (languageFromFileName(name) == null) continue;
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
export async function collectFullDirectorySource({ projectDir, maxFiles, maxFileChars, maxInputChars }) {
  const paths = await listSupportedFilesRecursive(projectDir);
  paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (paths.length === 0) {
    throw new AppError(ErrorCodes.NO_REVIEWABLE_SOURCE, '没有可审查的源代码', []);
  }
  if (paths.length > maxFiles) {
    throw new AppError(
      ErrorCodes.SOURCE_FILE_LIMIT_EXCEEDED,
      '文件数超过上限',
      [`files=${paths.length}`, `maxFiles=${maxFiles}`]
    );
  }

  /** @type {object[]} */
  const files = [];
  /** @type {Record<string, string>} */
  const contents = {};
  /** @type {string[]} */
  const sizeDetails = [];
  let totalCharacters = 0;

  for (const relPath of paths) {
    const abs = path.join(projectDir, ...relPath.split('/'));
    const buf = await fs.readFile(abs);
    if (isBinaryBuffer(buf)) {
      throw new AppError(ErrorCodes.SOURCE_SIZE_LIMIT_EXCEEDED, '检测到二进制文件，已拒绝', [relPath]);
    }
    const raw = buf.toString('utf8');
    const numbered = numberLines(raw);
    if (numbered.length > maxFileChars) {
      sizeDetails.push(`${relPath}:chars=${numbered.length}`);
    }
    totalCharacters += numbered.length;
    contents[relPath] = numbered;

    const lineCount = lineCountOf(raw);
    const language = languageFromFileName(path.basename(relPath));
    files.push({
      path: relPath,
      language,
      status: 'ADDED',
      contentHash: sha256Text(raw),
      changedLines: range1To(lineCount),
      lineCount,
      oldPath: null
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
