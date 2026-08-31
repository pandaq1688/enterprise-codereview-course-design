import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';

const FINDING_ALIASES = Object.freeze({
  risk_level: 'riskLevel',
  file_path: 'filePath',
  line_start: 'lineStart',
  line_end: 'lineEnd',
  requirement_reference: 'requirementReference',
  fix_suggestion: 'fixSuggestion',
  fix_code: 'fixCode'
});

const REQUIRED_FINDING_FIELDS = Object.freeze([
  'category',
  'risk_level',
  'title',
  'description',
  'file_path',
  'evidence'
]);

/**
 * @param {Record<string, unknown>} obj
 * @param {string} snakeKey
 * @returns {unknown}
 */
function getField(obj, snakeKey) {
  if (Object.prototype.hasOwnProperty.call(obj, snakeKey)) {
    return obj[snakeKey];
  }
  const alias = FINDING_ALIASES[snakeKey];
  if (alias && Object.prototype.hasOwnProperty.call(obj, alias)) {
    return obj[alias];
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {number | null | undefined}
 */
function normalizeLineNumber(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizeRisk(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.toUpperCase();
}

/**
 * Find the matching closing `}` for an object starting at `start`,
 * respecting JSON string escaping so braces inside strings are ignored.
 * @param {string} text
 * @param {number} start index of `{`
 * @returns {number} index of matching `}`, or -1 if incomplete
 */
function matchObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * @param {unknown} parsed
 * @returns {boolean}
 */
function looksLikeReviewObject(parsed) {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof /** @type {Record<string, unknown>} */ (parsed).summary === 'string' &&
    Array.isArray(/** @type {Record<string, unknown>} */ (parsed).findings)
  );
}

/**
 * @param {string} raw
 * @returns {string}
 */
function extractJsonText(raw) {
  let text = raw.trim();
  if (text.startsWith('```')) {
    const lines = text.split('\n');
    lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim() === '```') {
      lines.pop();
    }
    text = lines.join('\n').trim();
  }

  /**
   * @param {string} candidate
   * @returns {unknown | null}
   */
  function tryParseObject(candidate) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // not valid JSON
    }
    return null;
  }

  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    const end = matchObjectEnd(text, firstBrace);
    if (end !== -1) {
      const candidate = text.slice(firstBrace, end + 1);
      if (tryParseObject(candidate) !== null) {
        return candidate;
      }
    }
  }

  // Agent reconnect can concatenate a truncated object with a full retry payload.
  // Prefer the last complete object that looks like a review result.
  /** @type {string | null} */
  let lastReview = null;
  /** @type {string | null} */
  let lastAny = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') {
      continue;
    }
    const end = matchObjectEnd(text, i);
    if (end === -1) {
      continue;
    }
    const candidate = text.slice(i, end + 1);
    const parsed = tryParseObject(candidate);
    if (parsed === null) {
      continue;
    }
    lastAny = candidate;
    if (looksLikeReviewObject(parsed)) {
      lastReview = candidate;
    }
  }

  if (lastReview !== null) {
    return lastReview;
  }
  if (lastAny !== null) {
    return lastAny;
  }

  throw new AppError(ErrorCodes.AI_OUTPUT_INVALID_JSON, 'AI 输出不是合法 JSON', []);
}

/**
 * @param {Record<string, unknown>} rawFinding
 */
function validateFinding(rawFinding) {
  for (const field of REQUIRED_FINDING_FIELDS) {
    if (getField(rawFinding, field) === undefined) {
      throw new AppError(ErrorCodes.AI_OUTPUT_SCHEMA_INVALID, 'AI 输出不符合 Schema', []);
    }
  }
}

/**
 * @param {Record<string, unknown>} rawFinding
 * @returns {Record<string, unknown>}
 */
function mapFinding(rawFinding) {
  validateFinding(rawFinding);

  /** @type {Record<string, unknown>} */
  const finding = {
    category: getField(rawFinding, 'category'),
    risk_level: normalizeRisk(getField(rawFinding, 'risk_level')),
    title: getField(rawFinding, 'title'),
    description: getField(rawFinding, 'description'),
    file_path: getField(rawFinding, 'file_path'),
    evidence: getField(rawFinding, 'evidence')
  };

  if ('line_start' in rawFinding || 'lineStart' in rawFinding) {
    finding.line_start = normalizeLineNumber(getField(rawFinding, 'line_start'));
  }
  if ('line_end' in rawFinding || 'lineEnd' in rawFinding) {
    finding.line_end = normalizeLineNumber(getField(rawFinding, 'line_end'));
  }

  const requirementReference = getField(rawFinding, 'requirement_reference');
  if (requirementReference !== undefined) {
    finding.requirement_reference = requirementReference;
  }

  const fixSuggestion = getField(rawFinding, 'fix_suggestion');
  if (fixSuggestion !== undefined) {
    finding.fix_suggestion = fixSuggestion;
  }

  const fixCode = getField(rawFinding, 'fix_code');
  if (fixCode !== undefined) {
    finding.fix_code = fixCode;
  }

  return finding;
}

/**
 * @param {string} raw
 * @returns {{
 *   summary: string,
 *   overall_risk: string,
 *   findings: Record<string, unknown>[],
 *   evidence: unknown[],
 *   recommended_actions: unknown[]
 * }}
 */
export function parseReviewOutput(raw) {
  const jsonText = extractJsonText(raw);

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new AppError(ErrorCodes.AI_OUTPUT_INVALID_JSON, 'AI 输出不是合法 JSON', []);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError(ErrorCodes.AI_OUTPUT_SCHEMA_INVALID, 'AI 输出不符合 Schema', []);
  }

  /** @type {Record<string, unknown>} */
  const obj = parsed;

  if (typeof obj.summary !== 'string') {
    throw new AppError(ErrorCodes.AI_OUTPUT_SCHEMA_INVALID, 'AI 输出不符合 Schema', []);
  }

  if (!Array.isArray(obj.findings)) {
    throw new AppError(ErrorCodes.AI_OUTPUT_SCHEMA_INVALID, 'AI 输出不符合 Schema', []);
  }

  const overallRiskRaw =
    Object.prototype.hasOwnProperty.call(obj, 'overall_risk')
      ? obj.overall_risk
      : obj.overallRisk;
  const overallRisk = normalizeRisk(overallRiskRaw);
  if (overallRisk === undefined) {
    throw new AppError(ErrorCodes.AI_OUTPUT_SCHEMA_INVALID, 'AI 输出不符合 Schema', []);
  }

  const findings = obj.findings.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new AppError(ErrorCodes.AI_OUTPUT_SCHEMA_INVALID, 'AI 输出不符合 Schema', []);
    }
    return mapFinding(/** @type {Record<string, unknown>} */ (item));
  });

  return {
    summary: obj.summary,
    overall_risk: overallRisk,
    findings,
    evidence: Array.isArray(obj.evidence) ? obj.evidence : [],
    recommended_actions: Array.isArray(obj.recommended_actions) ? obj.recommended_actions : []
  };
}
