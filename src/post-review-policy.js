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
const RISK_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const SPECULATIVE_RE = /可能|也许|推测|假设|无法确认/;
const UNKNOWN_INTERFACE_RE = /未知第三方接口|未知异步语义|旧版本升级路径|未提供的旧版本/;
const CODE_EVIDENCE_RE = /->|::|\bnull\b|\bnullptr\b|\b[A-Za-z_]\w*\b/i;
const CODE_SEMANTICS_RE = /未判空|解引用|越界|未初始化/;
const PERF_EVIDENCE_RE = /复杂度|循环|热点|O\(|调用次数/;
const CATASTROPHIC_RE =
  /远程代码执行|RCE|鉴权绕过|认证绕过|不可恢复|数据破坏|大范围.*数据|任意代码执行/i;

/**
 * Severe floor (PF-007) requires category-aligned issue signals so unrelated
 * findings are not re-raised after earlier downgrades (e.g. PF-003).
 * @param {object} finding
 * @returns {boolean}
 */
function isSevereFloorCandidate(finding) {
  // PF-006 already caps these; never floor them back up via PF-007.
  if (
    finding.category === 'MAINTAINABILITY' ||
    finding.category === 'PERFORMANCE' ||
    finding.category === 'OTHER'
  ) {
    return false;
  }

  const blob = `${finding.title}\n${finding.description}\n${finding.evidence}`;
  if (finding.category === 'MEMORY_SAFETY') {
    return /未初始化|空指针|越界|use-after-free|重复释放/i.test(blob);
  }
  if (finding.category === 'CONCURRENCY') {
    return /数据竞争|死锁/.test(blob);
  }
  if (finding.category === 'SECURITY') {
    return /注入|进程退出|服务不可用/.test(blob);
  }
  return /进程退出|服务不可用/.test(blob);
}

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
 * @param {string} title
 * @returns {string}
 */
function normalizeTitleFingerprint(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function lineRangesOverlap(a, b) {
  if (a.lineStart === null || b.lineStart === null) return false;
  const aStart = a.lineStart;
  const aEnd = a.lineEnd ?? aStart;
  const bStart = b.lineStart;
  const bEnd = b.lineEnd ?? bStart;
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * @param {string} risk
 * @param {string} other
 * @returns {string}
 */
function maxRisk(risk, other) {
  return RISK_RANK[risk] >= RISK_RANK[other] ? risk : other;
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
  if (SPECULATIVE_RE.test(e) && !CODE_EVIDENCE_RE.test(e) && !CODE_SEMANTICS_RE.test(e)) {
    return false;
  }
  return CODE_EVIDENCE_RE.test(e) || CODE_SEMANTICS_RE.test(e);
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
 * @param {object} finding
 */
function applyPf006(finding) {
  if (finding.category === 'MAINTAINABILITY' && MID_HIGH_RISKS.has(finding.finalRisk)) {
    const before = finding.finalRisk;
    finding.finalRisk = 'LOW';
    pushDecision(
      finding,
      'PF-006',
      'DOWNGRADED',
      before,
      'LOW',
      '可维护性问题默认最高为 LOW'
    );
    finding.status = 'DOWNGRADED';
    return;
  }

  if (finding.category === 'PERFORMANCE' && MID_HIGH_RISKS.has(finding.finalRisk)) {
    const text = `${finding.title}\n${finding.description}\n${finding.evidence}`;
    if (!PERF_EVIDENCE_RE.test(text)) {
      const before = finding.finalRisk;
      finding.finalRisk = 'LOW';
      pushDecision(
        finding,
        'PF-006',
        'DOWNGRADED',
        before,
        'LOW',
        '性能问题缺少复杂度、循环或热点类证据，最高为 LOW'
      );
      finding.status = 'DOWNGRADED';
      return;
    }
  }

  if (finding.category === 'OTHER' && MID_HIGH_RISKS.has(finding.finalRisk)) {
    const before = finding.finalRisk;
    finding.finalRisk = 'LOW';
    pushDecision(
      finding,
      'PF-006',
      'DOWNGRADED',
      before,
      'LOW',
      'OTHER 类别不能保持中高风险'
    );
    finding.status = 'DOWNGRADED';
  }
}

/**
 * @param {object} finding
 */
function applyPf007(finding) {
  const hasPreciseLocation = finding.lineStart !== null;
  const blob = `${finding.title}\n${finding.description}\n${finding.evidence}`;
  const hasDirectEvidence = String(finding.evidence ?? '').trim().length > 0;

  if (
    hasPreciseLocation &&
    hasDirectEvidence &&
    isSevereFloorCandidate(finding) &&
    RISK_RANK[finding.finalRisk] < RISK_RANK.HIGH
  ) {
    const before = finding.finalRisk;
    finding.finalRisk = 'HIGH';
    pushDecision(
      finding,
      'PF-007',
      'CORRECTED',
      before,
      'HIGH',
      '具备准确位置与明确证据的严重问题，最终风险不低于 HIGH'
    );
    finding.status = 'CORRECTED';
  }

  if (finding.finalRisk === 'CRITICAL') {
    const catastrophic = CATASTROPHIC_RE.test(blob);
    if (!(catastrophic && hasPreciseLocation && hasDirectEvidence)) {
      const before = finding.finalRisk;
      finding.finalRisk = 'HIGH';
      pushDecision(
        finding,
        'PF-007',
        'DOWNGRADED',
        before,
        'HIGH',
        'CRITICAL 须同时满足灾难性影响、准确位置与直接证据，否则最高为 HIGH'
      );
      finding.status = 'DOWNGRADED';
    }
  }
}

/**
 * @param {object} finding
 */
function applyPf008(finding) {
  if (finding.category !== 'REQUIREMENT_MISMATCH') return;

  const hasRef = String(finding.requirementReference ?? '').trim().length > 0;
  const hasLocation = finding.lineStart !== null;

  if ((!hasRef || !hasLocation) && MID_HIGH_RISKS.has(finding.finalRisk)) {
    const before = finding.finalRisk;
    finding.finalRisk = 'LOW';
    pushDecision(
      finding,
      'PF-008',
      'DOWNGRADED',
      before,
      'LOW',
      '需求不符合类问题缺少 requirement_reference 或代码位置，降至 LOW'
    );
    finding.status = 'DOWNGRADED';
  }
}

/**
 * @param {object[]} findings
 */
function applyPf009(findings) {
  for (let i = 0; i < findings.length; i++) {
    const current = findings[i];
    if (current.status === 'EXEMPTED' || current.status === 'MERGED') continue;

    for (let j = 0; j < i; j++) {
      const primary = findings[j];
      if (primary.status === 'EXEMPTED' || primary.status === 'MERGED') continue;
      if (primary.filePath !== current.filePath) continue;
      if (primary.category !== current.category) continue;
      if (normalizeTitleFingerprint(primary.title) !== normalizeTitleFingerprint(current.title)) {
        continue;
      }
      if (!lineRangesOverlap(primary, current)) continue;

      const before = current.finalRisk;
      const beforePrimary = primary.finalRisk;
      const mergedRisk = maxRisk(primary.finalRisk, current.finalRisk);
      if (RISK_RANK[mergedRisk] > RISK_RANK[primary.finalRisk]) {
        primary.finalRisk = mergedRisk;
        pushDecision(
          primary,
          'PF-009',
          'CORRECTED',
          beforePrimary,
          mergedRisk,
          '合并重复 Finding 后采用更高最终风险'
        );
      }
      if (current.evidence && !primary.evidence.includes(current.evidence)) {
        primary.evidence = primary.evidence
          ? `${primary.evidence}\n${current.evidence}`
          : current.evidence;
      }

      // Re-apply legality caps so a merge cannot undo earlier downgrades.
      applyPf006(primary);
      applyPf007(primary);
      applyPf008(primary);

      current.status = 'MERGED';
      pushDecision(
        current,
        'PF-009',
        'MERGED',
        before,
        current.finalRisk,
        '与已有 Finding 在路径、行号、类别与标题上重复，合并为从项'
      );
      break;
    }
  }
}

/**
 * @param {object[]} findings
 * @returns {{ overallRisk: string, activeFindingCount: number, exemptedFindingCount: number, mergedFindingCount: number }}
 */
function applyPf010(findings) {
  let overallRisk = 'LOW';
  let activeFindingCount = 0;
  let exemptedFindingCount = 0;
  let mergedFindingCount = 0;

  for (const f of findings) {
    if (f.status === 'EXEMPTED') {
      exemptedFindingCount += 1;
      continue;
    }
    if (f.status === 'MERGED') {
      mergedFindingCount += 1;
      continue;
    }
    activeFindingCount += 1;
    overallRisk = maxRisk(overallRisk, f.finalRisk);
  }

  return { overallRisk, activeFindingCount, exemptedFindingCount, mergedFindingCount };
}

/**
 * @param {{ rawFindings: object[], selectedFiles: object[], sourceMode: string }} input
 * @returns {{ findings: object[], overallRisk: string, activeFindingCount: number, exemptedFindingCount: number, mergedFindingCount: number }}
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

    // PF-006 设计、风格与性能
    applyPf006(finding);

    // PF-007 严重风险修正
    applyPf007(finding);

    // PF-008 需求不符合
    applyPf008(finding);

    return finding;
  });

  // PF-009 重复问题
  applyPf009(findings);

  // PF-010 最终风险重算
  const aggregates = applyPf010(findings);

  return { findings, ...aggregates };
}
