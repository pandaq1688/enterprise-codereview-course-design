import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';
import { sha256Text } from './shared/hash.js';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isMarkdownPath(filePath) {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * @param {{ filePath: string, maxChars: number }} opts
 * @returns {Promise<{ text: string, characterCount: number, contentHash: string }>}
 */
export async function loadRequirement({ filePath, maxChars }) {
  if (!isMarkdownPath(filePath)) {
    throw new AppError(ErrorCodes.REQUIREMENT_NOT_MARKDOWN, '需求文件必须是 Markdown 格式', []);
  }

  const text = await fs.readFile(filePath, 'utf8');

  if (text.trim().length === 0) {
    throw new AppError(ErrorCodes.REQUIREMENT_EMPTY, '需求文件为空', []);
  }

  if (text.length > maxChars) {
    throw new AppError(ErrorCodes.SOURCE_SIZE_LIMIT_EXCEEDED, '需求文档超过大小上限', ['requirement']);
  }

  return {
    text,
    characterCount: text.length,
    contentHash: sha256Text(text)
  };
}
