const VALID_RISKS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const VALID_CATEGORIES = new Set([
  'SECURITY',
  'CORRECTNESS',
  'MEMORY_SAFETY',
  'CONCURRENCY',
  'RESOURCE_LIFECYCLE',
  'REQUIREMENT_MISMATCH',
  'MAINTAINABILITY',
  'PERFORMANCE',
  'OTHER'
]);
const MID_HIGH_RISKS = new Set(['MEDIUM', 'HIGH', 'CRITICAL']);
const SPECULATIVE_RE = /可能|也许|推测|假设|无法确认/;
const UNKNOWN_INTERFACE_RE = /未知第三方接口|未知异步语义|旧版本升级路径|未提供的旧版本/;
const CODE_EVIDENCE_RE = /->|::|\.|\[|\]|\(|\)|=|;|return\b|\bnull\b|\bnullptr\b|p->x/i;

/**
 * @param {number} index
 * @returns {string}
 */
function makeFindingId(index) {
  return `F-${String(index + 1).padStart(3, '0')}`;
}

/**
 * @param {unknown} value
 * @returns {{ value: number | null, changed: boolean }}
 */
function normalizeLine(value) {
  if (value === undefined) {
    return { value: null, changed: false };
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return { value, changed: false };
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return { value: Number.parseInt(value.trim(), 10), changed: true };
  }
  return { value: null, changed: true };
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function toPosixPath(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/');
}

/**
 * @param {object} f
 * @param {string} policyId
 * @param {string} action
 * @param {string} beforeRisk
 * @param {string} afterRisk
 * @param {string} reason
 */
function pushDecision(f, policyId, action, beforeRisk, afterRisk, reason) {
  f.decisions.push({ policyId, action, beforeRisk, afterRisk, reason });
}

/**
 * @param {object} f
 * @returns {boolean}
 */
function isCrashClass(f) {
  if (f.category !== 'MEMORY_SAFETY') return false;
  const text = `${f.title}\n${f.description}\n${f.evidence}`;
  return /空指针|越界|use-after-free|重复释放|未初始化/i.test(text);
}

/**
 * @param {string} evidence
 * @returns {boolean}
 */
function hasConcreteCodeEvidence(evidence) {
  const e = String(evidence ?? '').trim();
  if (!e) return false;
  if (SPECULATIVE_RE.test(e) && !CODE_EVIDENCE_RE.test(e)) return false;
  return CODE_EVIDENCE_RE.test(e) || /未判空|解引用|越界|未初始化/.test(e);
}

/**
 * @param {string} evidence
 * @returns {boolean}
 */
function hasInRepoCodeEvidence(evidence) {
  const e = String(evidence ?? '').trim();
  if (!e) return false;
  if (/无本仓库|未知|无法确认/.test(e) && !CODE_EVIDENCE_RE.test(e)) return false;
  return CODE_EVIDENCE_RE.test(e);
}

/**
 * @param {object} finding
 * @param {object} selected
 * @returns {boolean}
 */
function intersectsChangedLines(finding, selected) {
  if (!Array.isArray(selected.changedLines)) return true;
  const start = finding.lineStart;
  const end = finding.lineEnd ?? start;
  return selected.changedLines.some((ln) => ln >= start && ln <= end);
}

/**
 * @param {{ rawFindings: object[], selectedFiles: object[], sourceMode: string }} input
 * @returns {{ findings: object[] }}
 */
export function applyPostReviewPolicy({ rawFindings, selectedFiles, sourceMode }) {
  const selectedByPath = new Map(
    (selectedFiles ?? []).map((s) => [toPosixPath(s.path), s])
  );

  const findings = (rawFindings ?? []).map((raw, index) => {
    const decisions = [];
    const finding = {
      findingId: makeFindingId(index),
      category: raw.category,
      title: raw.title ?? '',
      description: raw.description ?? '',
      filePath: raw.file_path ?? raw.filePath ?? '',
      lineStart: raw.line_start ?? raw.lineStart,
      lineEnd: raw.line_end ?? raw.lineEnd,
      evidence: raw.evidence ?? '',
      requirementReference: raw.requirement_reference ?? raw.requirementReference ?? '',
      fixSuggestion: raw.fix_suggestion ?? raw.fixSuggestion ?? '',
      fixCode: raw.fix_code ?? raw.fixCode ?? '',
      originalRisk: null,
      finalRisk: null,
      status: 'KEPT',
      decisions
    };

    // PF-001 字段与枚举归一化
    const beforeRiskRaw = String(raw.risk_level ?? raw.riskLevel ?? '');
    let risk = beforeRiskRaw.toUpperCase();
    let corrected = false;
    const beforeForDecision = beforeRiskRaw || risk;

    if (!VALID_RISKS.has(risk)) {
      risk = 'LOW';
      corrected = true;
    } else if (beforeRiskRaw !== risk) {
      corrected = true;
    }

    if (!VALID_CATEGORIES.has(finding.category)) {
      finding.category = 'OTHER';
      corrected = true;
    }

    const beforePath = finding.filePath;
    finding.filePath = toPosixPath(finding.filePath);
    if (finding.filePath !== beforePath) {
      corrected = true;
    }

    const startNorm = normalizeLine(finding.lineStart);
    const endNorm = normalizeLine(finding.lineEnd);
    finding.lineStart = startNorm.value;
    finding.lineEnd = endNorm.value;
    if (startNorm.changed || endNorm.changed) {
      corrected = true;
    }

    finding.originalRisk = risk;
    finding.finalRisk = risk;

    if (corrected) {
      pushDecision(
        finding,
        'PF-001',
        'CORRECTED',
        beforeForDecision || risk,
        risk,
        '归一化风险等级、类别与路径字段'
      );
      finding.status = 'CORRECTED';
    } else {
      pushDecision(finding, 'PF-001', 'KEPT', risk, risk, '字段已符合规范，保持不变');
    }

    // PF-002 审查范围
    const selected = selectedByPath.get(finding.filePath);
    if (!selected) {
      pushDecision(
        finding,
        'PF-002',
        'EXEMPTED',
        finding.finalRisk,
        finding.finalRisk,
        'OUT_OF_SCOPE_FILE：问题不在本次选中文件范围内'
      );
      finding.status = 'EXEMPTED';
      return finding;
    }

    // PF-003 定位证据
    const lineCount = selected.lineCount ?? 0;
    const lineStart = finding.lineStart;

    if (lineStart !== null && (lineStart < 1 || (lineCount > 0 && lineStart > lineCount))) {
      pushDecision(
        finding,
        'PF-003',
        'EXEMPTED',
        finding.finalRisk,
        finding.finalRisk,
        '定位行号越界，予以豁免'
      );
      finding.status = 'EXEMPTED';
      return finding;
    }

    if (lineStart === null && MID_HIGH_RISKS.has(finding.finalRisk)) {
      const before = finding.finalRisk;
      finding.finalRisk = 'LOW';
      pushDecision(
        finding,
        'PF-003',
        'DOWNGRADED',
        before,
        'LOW',
        '缺少精确位置，不能保持中高风险'
      );
      finding.status = 'DOWNGRADED';
    } else if (
      sourceMode === 'GIT_CHANGES' &&
      lineStart !== null &&
      MID_HIGH_RISKS.has(finding.finalRisk) &&
      !intersectsChangedLines(finding, selected) &&
      !isCrashClass(finding)
    ) {
      const before = finding.finalRisk;
      finding.finalRisk = 'LOW';
      pushDecision(
        finding,
        'PF-003',
        'DOWNGRADED',
        before,
        'LOW',
        'Git 模式下未定位到新增或修改行，非崩溃类中高风险降至 LOW'
      );
      finding.status = 'DOWNGRADED';
    }

    // PF-004 推测性结论
    const speculativeText = `${finding.title}\n${finding.description}`;
    if (SPECULATIVE_RE.test(speculativeText) && !hasConcreteCodeEvidence(finding.evidence)) {
      pushDecision(
        finding,
        'PF-004',
        'EXEMPTED',
        finding.finalRisk,
        finding.finalRisk,
        '结论含推测性措辞且缺少明确代码证据，予以豁免'
      );
      finding.status = 'EXEMPTED';
      return finding;
    }

    // PF-005 未知接口与兼容性
    if (
      UNKNOWN_INTERFACE_RE.test(finding.description) &&
      !hasInRepoCodeEvidence(finding.evidence)
    ) {
      pushDecision(
        finding,
        'PF-005',
        'EXEMPTED',
        finding.finalRisk,
        finding.finalRisk,
        '基于未知第三方接口或旧版本升级路径的结论且无本仓库代码证据，予以豁免'
      );
      finding.status = 'EXEMPTED';
      return finding;
    }

    return finding;
  });

  return { findings };
}
