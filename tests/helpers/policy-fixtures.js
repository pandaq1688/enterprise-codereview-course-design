export function rawFinding(overrides = {}) {
  return {
    category: 'CORRECTNESS',
    risk_level: 'HIGH',
    title: '空指针解引用',
    description: '在第 3 行对 p 解引用，p 可能为空',
    file_path: 'src/a.cpp',
    line_start: 3,
    line_end: 3,
    evidence: 'p->x 且 p 未判空',
    requirement_reference: '',
    fix_suggestion: '先判空',
    fix_code: '',
    ...overrides
  };
}

export function selected(path = 'src/a.cpp', changedLines = [3], lineCount = 10, status = 'MODIFIED') {
  return { path, changedLines, lineCount, status };
}
