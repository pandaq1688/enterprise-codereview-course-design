import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderHtmlReport } from './html-report-renderer.js';
import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';
import { REPORT_SCHEMA_VERSION } from './shared/versions.js';

/**
 * @param {{ reportsDir: string, idFactory?: () => string }} opts
 */
export function createFileReportRepository({ reportsDir, idFactory = crypto.randomUUID }) {
  function createReviewId() {
    return idFactory();
  }

  /**
   * @param {object} report
   */
  async function save(report) {
    const id = report.reviewId;
    const tmpDir = path.join(reportsDir, `.tmp-${id}`);
    const finalDir = path.join(reportsDir, id);

    try {
      await fs.mkdir(tmpDir, { recursive: true });
      const reportToSave = {
        ...report,
        schemaVersion: report.schemaVersion ?? REPORT_SCHEMA_VERSION
      };
      await fs.writeFile(
        path.join(tmpDir, 'report.json'),
        JSON.stringify(reportToSave, null, 2),
        'utf8'
      );
      await fs.writeFile(path.join(tmpDir, 'report.html'), renderHtmlReport(reportToSave), 'utf8');
      await fs.rename(tmpDir, finalDir);
    } catch {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new AppError(ErrorCodes.REPORT_WRITE_FAILED, '报告写入失败', []);
    }
  }

  /**
   * @param {string} reviewId
   */
  async function read(reviewId) {
    const jsonPath = path.join(reportsDir, reviewId, 'report.json');
    const text = await fs.readFile(jsonPath, 'utf8');
    return JSON.parse(text);
  }

  async function listSummaries() {
    let entries;
    try {
      entries = await fs.readdir(reportsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const summaries = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.tmp-')) {
        continue;
      }
      try {
        const text = await fs.readFile(path.join(reportsDir, entry.name, 'report.json'), 'utf8');
        const report = JSON.parse(text);
        summaries.push({
          createdAt: report.createdAt,
          projectName: report.request?.projectName,
          sourceMode: report.request?.sourceMode,
          status: report.status,
          overallRisk: report.result?.overallRisk,
          activeFindingCount: report.result?.activeFindingCount,
          exemptedFindingCount: report.result?.exemptedFindingCount,
          durationMs: report.durationMs,
          reviewId: report.reviewId
        });
      } catch {
        continue;
      }
    }

    summaries.sort((a, b) => {
      const aTime = a.createdAt ?? '';
      const bTime = b.createdAt ?? '';
      return bTime.localeCompare(aTime);
    });

    return summaries;
  }

  return { createReviewId, save, read, listSummaries };
}
