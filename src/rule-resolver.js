import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256Text } from './shared/hash.js';
import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';

const CHECKLIST_MAX_CHARS = 80000;

const BUILTIN_FILES = Object.freeze({
  GLOBAL: 'global-review.md',
  CPP: 'cpp-review.md',
  JAVA: 'java-review.md',
  JS: 'js-review.md'
});

/**
 * Path-prefix match on segment boundaries. '.' matches all.
 * @param {string} filePath
 * @param {string} prefix
 * @returns {boolean}
 */
function matchesPathPrefix(filePath, prefix) {
  const file = String(filePath).replace(/\\/g, '/');
  const p = String(prefix).replace(/\\/g, '/').replace(/\/+$/, '');
  if (p === '.' || p === '') return true;
  return file === p || file.startsWith(p + '/');
}

/**
 * @param {string} filePath
 * @param {string[]} includePaths
 * @param {string[]} excludePaths
 * @returns {boolean}
 */
function isChecklistMatched(filePath, includePaths, excludePaths) {
  const included = (includePaths ?? []).some((p) => matchesPathPrefix(filePath, p));
  if (!included) return false;
  const excluded = (excludePaths ?? []).some((p) => matchesPathPrefix(filePath, p));
  return !excluded;
}

/**
 * @param {string} filePath
 * @param {string} [ruleLabel]
 * @returns {Promise<string>}
 */
async function readRuleFile(filePath, ruleLabel = filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new AppError(
      ErrorCodes.RULE_READ_FAILED,
      `读取规则失败: ${ruleLabel}`,
      [filePath, err instanceof Error ? err.message : String(err)]
    );
  }
}

/**
 * @param {object} opts
 * @param {string} opts.ruleId
 * @param {'GLOBAL'|'CPP'|'JAVA'|'JS'|'CHECKLIST'} opts.ruleType
 * @param {boolean} opts.builtIn
 * @param {string} opts.content
 * @param {string[]} opts.matchPaths
 * @param {string[]} opts.matchedFiles
 */
function toResolvedRule({ ruleId, ruleType, builtIn, content, matchPaths, matchedFiles }) {
  return {
    ruleId,
    ruleType,
    builtIn,
    content,
    contentHash: sha256Text(content),
    matchPaths,
    matchedFiles
  };
}

/**
 * @param {{
 *   projectDir: string,
 *   files: Array<{ path: string, language: string }>,
 *   checklist: {
 *     enabled: boolean,
 *     path: string | null,
 *     includePaths: string[],
 *     excludePaths: string[]
 *   },
 *   rulesDir?: string
 * }} opts
 * @returns {Promise<{ rules: object[], checklistLoaded: boolean }>}
 */
export async function resolveRules({ projectDir, files, checklist, rulesDir }) {
  void projectDir;
  const dir = rulesDir ?? path.join(process.cwd(), 'docs', 'rules');
  const inputFiles = files ?? [];
  /** @type {object[]} */
  const rules = [];

  const allPaths = inputFiles.map((f) => f.path);
  const globalContent = await readRuleFile(path.join(dir, BUILTIN_FILES.GLOBAL), BUILTIN_FILES.GLOBAL);
  rules.push(
    toResolvedRule({
      ruleId: 'GLOBAL',
      ruleType: 'GLOBAL',
      builtIn: true,
      content: globalContent,
      matchPaths: ['.'],
      matchedFiles: allPaths
    })
  );

  const cppFiles = inputFiles.filter((f) => f.language === 'CPP').map((f) => f.path);
  if (cppFiles.length > 0) {
    const content = await readRuleFile(path.join(dir, BUILTIN_FILES.CPP), BUILTIN_FILES.CPP);
    rules.push(
      toResolvedRule({
        ruleId: 'CPP',
        ruleType: 'CPP',
        builtIn: true,
        content,
        matchPaths: cppFiles,
        matchedFiles: cppFiles
      })
    );
  }

  const javaFiles = inputFiles.filter((f) => f.language === 'JAVA').map((f) => f.path);
  if (javaFiles.length > 0) {
    const content = await readRuleFile(path.join(dir, BUILTIN_FILES.JAVA), BUILTIN_FILES.JAVA);
    rules.push(
      toResolvedRule({
        ruleId: 'JAVA',
        ruleType: 'JAVA',
        builtIn: true,
        content,
        matchPaths: javaFiles,
        matchedFiles: javaFiles
      })
    );
  }

  const jsFiles = inputFiles.filter((f) => f.language === 'JS').map((f) => f.path);
  if (jsFiles.length > 0) {
    const content = await readRuleFile(path.join(dir, BUILTIN_FILES.JS), BUILTIN_FILES.JS);
    rules.push(
      toResolvedRule({
        ruleId: 'JS',
        ruleType: 'JS',
        builtIn: true,
        content,
        matchPaths: jsFiles,
        matchedFiles: jsFiles
      })
    );
  }

  let checklistLoaded = false;
  if (checklist?.enabled) {
    const includePaths = checklist.includePaths ?? ['.'];
    const excludePaths = checklist.excludePaths ?? [];
    const matchedFiles = inputFiles
      .map((f) => f.path)
      .filter((p) => isChecklistMatched(p, includePaths, excludePaths));

    if (matchedFiles.length > 0) {
      if (!checklist.path) {
        throw new AppError(ErrorCodes.RULE_READ_FAILED, 'checklist 已启用但未提供路径', []);
      }
      const content = await readRuleFile(checklist.path, 'checklist');
      if (content.length > CHECKLIST_MAX_CHARS) {
        throw new AppError(
          ErrorCodes.SOURCE_SIZE_LIMIT_EXCEEDED,
          'checklist 超过大小上限',
          ['checklist']
        );
      }
      rules.push(
        toResolvedRule({
          ruleId: 'CHECKLIST',
          ruleType: 'CHECKLIST',
          builtIn: false,
          content,
          matchPaths: includePaths,
          matchedFiles
        })
      );
      checklistLoaded = true;
    }
  }

  return { rules, checklistLoaded };
}
