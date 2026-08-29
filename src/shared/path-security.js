import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './app-error.js';
import { ErrorCodes } from './error-codes.js';

function normalizeForCompare(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function resolveRealPath(inputPath) {
  try {
    return await fs.realpath(inputPath);
  } catch {
    throw new AppError(ErrorCodes.PATH_NOT_FOUND, '路径不存在或无法解析', [inputPath]);
  }
}

function isInside(realPath, realRoot) {
  const rel = path.relative(normalizeForCompare(realRoot), normalizeForCompare(realPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function assertInsideAllowedRoots(realPath, allowedRoots, lexicalPath = realPath) {
  if (!allowedRoots || allowedRoots.length === 0) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'allowedRoots 必须至少配置一项', []);
  }
  const ok = allowedRoots.some((root) => isInside(realPath, root));
  if (ok) return;
  const lexicalInside = allowedRoots.some((root) => isInside(path.resolve(lexicalPath), root));
  if (lexicalInside && normalizeForCompare(lexicalPath) !== normalizeForCompare(realPath)) {
    throw new AppError(ErrorCodes.PATH_SYMLINK_ESCAPE, '路径通过符号链接逃出允许访问的根目录', []);
  }
  throw new AppError(ErrorCodes.PATH_OUTSIDE_ALLOWED_ROOT, '项目目录不在允许访问的根目录中', []);
}

export function toPosixRelative(fromRoot, absolutePath) {
  return path.relative(fromRoot, absolutePath).split(path.sep).join('/');
}
