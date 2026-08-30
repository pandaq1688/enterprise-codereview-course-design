import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';
import { resolveRealPath, assertInsideAllowedRoots } from './shared/path-security.js';
import { repoNameFromUrl } from './remote-git-fetcher.js';

const execFile = promisify(execFileCb);

const SOURCE_MODES = new Set(['GIT_CHANGES', 'FULL_DIRECTORY', 'REMOTE_GIT']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

/**
 * @param {string} absolutePath
 * @returns {string|null}
 */
export function toDisplayPath(absolutePath) {
  if (!absolutePath) return null;
  const parts = String(absolutePath).replace(/\\/g, '/').split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return parts.slice(-2).join('/');
}

function isMarkdownPath(filePath) {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function assertGitWorkTree(projectDir) {
  let inside;
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectDir,
      windowsHide: true
    });
    inside = String(stdout).trim();
  } catch {
    throw new AppError(ErrorCodes.GIT_REPOSITORY_REQUIRED, '当前项目不是 Git 工作区', []);
  }
  if (inside !== 'true') {
    throw new AppError(ErrorCodes.GIT_REPOSITORY_REQUIRED, '当前项目不是 Git 工作区', []);
  }
}

async function resolveAndAssert(lexicalPath, allowedRoots) {
  const realPath = await resolveRealPath(lexicalPath);
  assertInsideAllowedRoots(realPath, allowedRoots, lexicalPath);
  return realPath;
}

/**
 * @param {object} body
 * @param {object} config
 */
export async function validateCreateReviewRequest(body, config) {
  if (!body || typeof body !== 'object') {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体无效', []);
  }

  const allowedRoots = config?.security?.allowedRoots;
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'allowedRoots 必须至少配置一项', []);
  }

  if (!body.requirementFile || typeof body.requirementFile !== 'string') {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '缺少必填字段 requirementFile', []);
  }
  if (!SOURCE_MODES.has(body.sourceMode)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'sourceMode 非法', []);
  }

  let remoteUrl = null;
  let ref = null;
  let reviewMode = null;
  let projectDir = null;
  let projectName = null;
  let projectDirDisplay = null;

  if (body.sourceMode === 'REMOTE_GIT') {
    if (!body.remoteUrl || typeof body.remoteUrl !== 'string') {
      throw new AppError(ErrorCodes.INVALID_REQUEST, '缺少必填字段 remoteUrl', []);
    }
    if (!body.ref || typeof body.ref !== 'string') {
      throw new AppError(ErrorCodes.INVALID_REQUEST, '缺少必填字段 ref', []);
    }
    reviewMode = body.reviewMode ?? 'GIT_CHANGES';
    if (reviewMode !== 'GIT_CHANGES' && reviewMode !== 'FULL_DIRECTORY') {
      throw new AppError(ErrorCodes.INVALID_REQUEST, 'reviewMode 非法', []);
    }
    remoteUrl = body.remoteUrl;
    ref = body.ref;
    projectName = repoNameFromUrl(remoteUrl);
  } else {
    if (!body.projectDir || typeof body.projectDir !== 'string') {
      throw new AppError(ErrorCodes.INVALID_REQUEST, '缺少必填字段 projectDir', []);
    }
    projectDir = await resolveAndAssert(body.projectDir, allowedRoots);
    projectName = path.basename(projectDir);
    projectDirDisplay = toDisplayPath(projectDir);
  }

  const requirementFile = await resolveAndAssert(body.requirementFile, allowedRoots);

  if (!isMarkdownPath(requirementFile)) {
    throw new AppError(ErrorCodes.REQUIREMENT_NOT_MARKDOWN, '需求文件必须是 Markdown 格式', []);
  }

  const checklistInput = body.checklist ?? config.checklist ?? {};
  const checklistEnabled = Boolean(checklistInput.enabled);
  let checklistPath = null;
  let checklistIncludePaths = Array.isArray(checklistInput.includePaths)
    ? checklistInput.includePaths
    : ['.'];
  let checklistExcludePaths = Array.isArray(checklistInput.excludePaths)
    ? checklistInput.excludePaths
    : [];

  if (checklistEnabled) {
    const rawChecklistPath = checklistInput.path ?? config.checklist?.path;
    if (!rawChecklistPath || typeof rawChecklistPath !== 'string') {
      throw new AppError(ErrorCodes.INVALID_REQUEST, 'checklist 已启用但未提供 path', []);
    }
    if (!isMarkdownPath(rawChecklistPath)) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, 'checklist 必须是 Markdown 文件', []);
    }
    checklistPath = await resolveAndAssert(rawChecklistPath, allowedRoots);
  }

  if (body.sourceMode === 'GIT_CHANGES') {
    await assertGitWorkTree(projectDir);
  }

  return {
    projectDir,
    requirementFile,
    sourceMode: body.sourceMode,
    remoteUrl,
    ref,
    reviewMode,
    checklist: {
      enabled: checklistEnabled,
      path: checklistPath,
      includePaths: checklistIncludePaths,
      excludePaths: checklistExcludePaths
    },
    projectName,
    projectDirDisplay,
    requirementFileDisplay: toDisplayPath(requirementFile),
    checklistFileDisplay: checklistPath ? toDisplayPath(checklistPath) : null
  };
}
