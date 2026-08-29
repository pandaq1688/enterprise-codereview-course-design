import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../shared/app-error.js';
import { ErrorCodes } from '../shared/error-codes.js';
import { renderHomePage, renderJobPage, renderReportPage } from './templates.js';

/** crypto.randomUUID() shape */
const REVIEW_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {unknown} reviewId
 * @returns {boolean}
 */
export function isValidReviewId(reviewId) {
  return typeof reviewId === 'string' && REVIEW_ID_RE.test(reviewId);
}

/**
 * Resolve a report artifact path and ensure it stays under reportsDir.
 * @param {string} reportsDir
 * @param {string} reviewId
 * @param {'report.html'|'report.json'} fileName
 * @returns {string|null}
 */
export function resolveReportArtifactPath(reportsDir, reviewId, fileName) {
  if (!isValidReviewId(reviewId)) return null;
  if (fileName !== 'report.html' && fileName !== 'report.json') return null;

  const root = path.resolve(reportsDir);
  const resolved = path.resolve(root, reviewId, fileName);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {string} raw
 * @param {string|undefined} contentType
 * @returns {object}
 */
function parseRequestBody(raw, contentType) {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/json') || raw.trimStart().startsWith('{')) {
    if (!raw.trim()) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体无效', []);
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体无效', []);
    }
  }

  if (ct.includes('application/x-www-form-urlencoded') || raw.includes('=')) {
    const params = new URLSearchParams(raw);
    const includeRaw = params.get('checklist.includePaths');
    const includePaths = includeRaw
      ? includeRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const enabledRaw = params.get('checklist.enabled');
    const checklistEnabled =
      enabledRaw === 'true' || enabledRaw === 'on' || enabledRaw === '1';

    /** @type {object} */
    const body = {
      projectDir: params.get('projectDir') || undefined,
      requirementFile: params.get('requirementFile') || undefined,
      sourceMode: params.get('sourceMode') || undefined,
      checklist: {
        enabled: checklistEnabled,
        path: params.get('checklist.path') || undefined,
        includePaths
      }
    };
    return body;
  }

  throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体无效', []);
}

/**
 * @param {AppError} err
 * @returns {number}
 */
function statusForAppError(err) {
  if (err.code === ErrorCodes.PATH_NOT_FOUND) return 404;
  return 400;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} html
 */
function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html)
  });
  res.end(html);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {AppError} err
 */
function sendAppError(res, err) {
  sendJson(res, statusForAppError(err), err.toJSON());
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} message
 */
function sendNotFound(res, message) {
  sendJson(res, 404, {
    error: {
      code: ErrorCodes.PATH_NOT_FOUND,
      message,
      details: []
    }
  });
}

/**
 * @param {string} pathname
 * @param {string} pattern
 * @returns {string[]|null}
 */
function matchPath(pathname, pattern) {
  const pathParts = pathname.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;
  /** @type {string[]} */
  const params = [];
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp.startsWith(':')) {
      params.push(decodeURIComponent(pathParts[i]));
    } else if (pp !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * @param {string} reportsDir
 * @param {string} reviewId
 * @param {'report.html'|'report.json'} fileName
 * @param {import('node:http').ServerResponse} res
 * @param {string} contentType
 */
async function serveReportArtifact(reportsDir, reviewId, fileName, res, contentType) {
  const filePath = resolveReportArtifactPath(reportsDir, reviewId, fileName);
  if (!filePath) {
    return sendNotFound(res, '报告文件不存在');
  }
  try {
    const text = await fs.readFile(filePath, 'utf8');
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(text);
  } catch {
    return sendNotFound(res, '报告文件不存在');
  }
}

/**
 * @param {{
 *   jobService: object,
 *   config: object,
 *   validateRequest: (body: object, config: object) => Promise<object>
 * }} deps
 * @returns {import('node:http').Server}
 */
export function createWebAdapter({ jobService, config, validateRequest }) {
  const reportsDir = path.resolve(config?.reports?.dir ?? './data/reports');

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    try {
      if (method === 'GET' && pathname === '/') {
        const summaries = await jobService.listReports();
        return sendHtml(res, 200, renderHomePage({ summaries }));
      }

      {
        const m = matchPath(pathname, '/jobs/:id');
        if (method === 'GET' && m) {
          if (!isValidReviewId(m[0])) {
            return sendNotFound(res, '任务不存在');
          }
          return sendHtml(res, 200, renderJobPage({ reviewId: m[0] }));
        }
      }

      {
        const m = matchPath(pathname, '/reports/:id/report.html');
        if (method === 'GET' && m) {
          return serveReportArtifact(
            reportsDir,
            m[0],
            'report.html',
            res,
            'text/html; charset=utf-8'
          );
        }
      }

      {
        const m = matchPath(pathname, '/reports/:id/report.json');
        if (method === 'GET' && m) {
          return serveReportArtifact(
            reportsDir,
            m[0],
            'report.json',
            res,
            'application/json; charset=utf-8'
          );
        }
      }

      {
        const m = matchPath(pathname, '/reports/:id');
        if (method === 'GET' && m) {
          if (!isValidReviewId(m[0])) {
            return sendNotFound(res, '报告不存在');
          }
          try {
            const report = await jobService.getReport(m[0]);
            return sendHtml(res, 200, renderReportPage(report));
          } catch {
            return sendNotFound(res, '报告不存在');
          }
        }
      }

      if (method === 'POST' && pathname === '/api/reviews') {
        const raw = await readBody(req);
        const body = parseRequestBody(raw, req.headers['content-type']);
        const normalized = await validateRequest(body, config);
        const result = jobService.enqueue(normalized, { triggerType: 'MANUAL' });
        return sendJson(res, 202, result);
      }

      {
        const m = matchPath(pathname, '/api/jobs/:id');
        if (method === 'GET' && m) {
          if (!isValidReviewId(m[0])) {
            return sendNotFound(res, '任务不存在');
          }
          const job = await jobService.getJob(m[0]);
          if (!job) {
            return sendNotFound(res, '任务不存在');
          }
          return sendJson(res, 200, job);
        }
      }

      if (method === 'GET' && pathname === '/api/reports') {
        const summaries = await jobService.listReports();
        return sendJson(res, 200, summaries);
      }

      {
        const m = matchPath(pathname, '/api/reports/:id');
        if (method === 'GET' && m) {
          if (!isValidReviewId(m[0])) {
            return sendNotFound(res, '报告不存在');
          }
          try {
            const report = await jobService.getReport(m[0]);
            return sendJson(res, 200, report);
          } catch {
            return sendNotFound(res, '报告不存在');
          }
        }
      }

      if (method === 'GET' && pathname === '/api/health') {
        const snap =
          typeof jobService.getHealthSnapshot === 'function'
            ? jobService.getHealthSnapshot()
            : { accepting: true, queueLength: 0, currentReviewId: null };
        return sendJson(res, 200, {
          status: 'ok',
          queueLength: snap.queueLength ?? 0,
          currentReviewId: snap.currentReviewId ?? null,
          accepting: snap.accepting !== false
        });
      }

      return sendNotFound(res, '未找到路由');
    } catch (err) {
      if (err instanceof AppError) {
        return sendAppError(res, err);
      }
      return sendJson(res, 500, {
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: '服务器内部错误',
          details: []
        }
      });
    }
  }

  return http.createServer((req, res) => {
    void handle(req, res);
  });
}
