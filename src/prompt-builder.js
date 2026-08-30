import { PROMPT_SCHEMA_VERSION } from './shared/versions.js';

const JSON_OUTPUT_SCHEMA_EXAMPLE = `{
  "summary": "本次审查摘要",
  "overall_risk": "LOW",
  "findings": [
    {
      "category": "CORRECTNESS",
      "risk_level": "MEDIUM",
      "title": "问题标题",
      "description": "问题说明",
      "file_path": "src/example.cpp",
      "line_start": 10,
      "line_end": 10,
      "evidence": "代码与需求中的直接证据",
      "requirement_reference": "需求章节或原文摘要",
      "fix_suggestion": "中文修复建议",
      "fix_code": "可选的替换代码"
    }
  ],
  "evidence": [],
  "recommended_actions": []
}`;

const ROLE_SECTION = `你是代码审查助手。请严格遵守以下原则：

- 只基于需求文档、源码或 diff 中的直接证据下结论，不得臆造未出现的事实。
- 禁止猜测外部接口行为、未知运行环境、未提供的依赖或部署细节。
- 没有准确文件位置和可核验证据时，不得给出 MEDIUM、HIGH 或 CRITICAL 风险结论。
- 最终回复必须且只能输出一个 JSON 对象，不得附加 Markdown 围栏、解释文字或其他内容。`;

const SELF_CHECK_SECTION = `输出 JSON 前请自检：

- 是否只输出了一个 JSON 对象。
- 每个 finding 是否具有非空标题、说明、文件路径、行号与具体证据。
- MEDIUM 及以上风险是否具备准确位置与可核验证据。
- 需求不符合问题是否提供了 requirement_reference。`;

/**
 * @param {object} input
 * @param {string} input.requirementText
 * @param {'GIT_CHANGES'|'FULL_DIRECTORY'} input.sourceMode
 * @param {Array<{ path: string, language: string, status?: string }>} input.files
 * @param {Record<string, string>} input.contents
 * @param {Array<{ ruleType: string, content: string }>} input.rules
 * @returns {{ text: string, characterCount: number }}
 */
export function buildPrompt({ requirementText, sourceMode, files, contents, rules }) {
  const ruleList = rules ?? [];
  const fileList = files ?? [];
  const contentMap = contents ?? {};

  const globalRules = ruleList.filter((r) => r.ruleType === 'GLOBAL').map((r) => r.content);
  const cppRules = ruleList.filter((r) => r.ruleType === 'CPP').map((r) => r.content);
  const javaRules = ruleList.filter((r) => r.ruleType === 'JAVA').map((r) => r.content);
  const jsRules = ruleList.filter((r) => r.ruleType === 'JS').map((r) => r.content);
  const checklistRules = ruleList.filter((r) => r.ruleType === 'CHECKLIST').map((r) => r.content);

  const scopeLines = [
    `模式: ${sourceMode}`,
    '文件清单:',
    ...fileList.map((f) => {
      const status = f.status ? ` (${f.status})` : '';
      return `- ${f.path} [${f.language}]${status}`;
    })
  ];

  const languageRuleBlocks = [];
  if (cppRules.length > 0) {
    languageRuleBlocks.push('### C/C++', ...cppRules);
  }
  if (javaRules.length > 0) {
    languageRuleBlocks.push('### Java', ...javaRules);
  }
  if (jsRules.length > 0) {
    languageRuleBlocks.push('### JavaScript', ...jsRules);
  }

  const sourceBlocks = fileList.map((f) => {
    const body = contentMap[f.path] ?? '';
    return `### ${f.path}\n${body}`;
  });

  const sections = [
    ['## 角色与证据原则', ROLE_SECTION],
    [
      '## JSON 输出契约',
      `提示词 schema 版本: ${PROMPT_SCHEMA_VERSION}`,
      '',
      'Cursor 必须只返回一个 JSON 对象：',
      '',
      JSON_OUTPUT_SCHEMA_EXAMPLE
    ],
    ['## 需求文档', requirementText ?? ''],
    ['## 审查范围', ...scopeLines],
    ['## 固定全局规则', ...globalRules],
    ['## 固定语言规则', ...(languageRuleBlocks.length > 0 ? languageRuleBlocks : ['（无语言规则）'])],
    [
      '## review-checklist',
      checklistRules.length > 0 ? checklistRules.join('\n\n') : '未启用'
    ],
    ['## 源码或 Diff', ...sourceBlocks],
    ['## 输出前自检', SELF_CHECK_SECTION]
  ];

  const text = sections.map((lines) => lines.join('\n')).join('\n\n');
  return { text, characterCount: text.length };
}
