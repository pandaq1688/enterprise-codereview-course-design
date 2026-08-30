import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 3100
  },
  review: {
    maxFiles: 50,
    maxFileChars: 80000,
    maxInputChars: 240000,
    maxRequirementChars: 50000,
    allowedExtensions: [
      '.c', '.cc', '.cpp', '.cxx',
      '.h', '.hpp', '.hxx', '.java'
    ]
  },
  cursor: {
    command: 'cursor-agent',
    args: [
      '--prompt-file', '{promptFile}',
      '--workspace', '{projectDir}',
      '--output', '{outputFile}'
    ],
    timeoutMs: 600000,
    maxOutputChars: 2000000
  },
  reports: {
    dir: './data/reports',
    includeAbsolutePaths: false
  },
  checklist: {
    enabled: true,
    path: './docs/rules/review-checklist.md',
    includePaths: ['.'],
    excludePaths: []
  },
  ai: {
    provider: 'cursor',
    remote: {
      baseUrl: 'https://api.example.com',
      model: 'review-model',
      apiKeyEnv: 'REMOTE_LLM_API_KEY',
      timeoutMs: 600000
    }
  },
  scheduler: {
    stateFile: './data/scheduler-state.json',
    profiles: []
  },
  remoteGit: {
    workspaceDir: './data/remotes',
    ephemeral: false,
    fetchRetries: 3,
    credentials: { type: 'https', tokenEnv: '', usernameEnv: '' }
  },
  analyzer: {
    enabled: false,
    tool: 'clang-tidy',
    command: 'clang-tidy',
    args: ['--export-fixes={outputFile}', '{file}'],
    timeoutMs: 300000,
    onAnalyzerError: 'skip'
  },
  sharding: {
    enabled: false,
    shardChars: 120000,
    maxShards: 20,
    maxConcurrency: 1
  }
};

const FORBIDDEN_RULE_PATH_KEYS = new Set([
  'globalPath',
  'cppPath',
  'cPath',
  'javaPath',
  'globalRulesPath',
  'cppRulesPath',
  'javaRulesPath',
  'globalRulePath',
  'cppRulePath',
  'javaRulePath'
]);

function deepMerge(base, override) {
  if (override === undefined || override === null) return structuredClone(base);
  if (Array.isArray(base) || Array.isArray(override)) {
    return Array.isArray(override) ? [...override] : structuredClone(base);
  }
  if (typeof base !== 'object' || typeof override !== 'object') {
    return override;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : structuredClone(value);
  }
  return out;
}

function assertNoFixedRuleOverrides(raw) {
  const rules = raw?.rules;
  if (!rules || typeof rules !== 'object') return;
  for (const key of Object.keys(rules)) {
    if (FORBIDDEN_RULE_PATH_KEYS.has(key) || /^(global|cpp|c|java).*path$/i.test(key)) {
      throw new Error('禁止通过外部配置替换全局/C++/Java 固定规则路径');
    }
  }
}

/**
 * @param {string} configPath
 */
export async function loadConfig(configPath) {
  let text;
  try {
    text = await fs.readFile(configPath, 'utf8');
  } catch {
    throw new Error(`配置文件不存在或无法读取: ${configPath}`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('配置文件 JSON 格式非法');
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('配置文件 JSON 格式非法');
  }

  assertNoFixedRuleOverrides(raw);

  const allowedRoots = raw.security?.allowedRoots;
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new Error('allowedRoots 必须至少配置一项');
  }

  const merged = deepMerge(DEFAULTS, raw);
  merged.security = {
    ...(merged.security || {}),
    allowedRoots: allowedRoots.map((root) => path.resolve(String(root)))
  };

  if (!Array.isArray(merged.cursor.args)) {
    throw new Error('cursor.args 必须是数组');
  }

  if (merged.ai?.provider === 'remote') {
    const envName = merged.ai?.remote?.apiKeyEnv;
    if (!envName || typeof envName !== 'string') {
      throw new Error('远程大模型未配置 apiKeyEnv 环境变量名');
    }
    if (!process.env[envName]) {
      throw new Error(`远程大模型 API Key 环境变量未设置: ${envName}`);
    }
  }

  const onAnalyzerError = merged.analyzer?.onAnalyzerError;
  if (onAnalyzerError !== 'skip' && onAnalyzerError !== 'fail') {
    throw new Error('analyzer.onAnalyzerError 必须是 skip 或 fail');
  }

  const fetchRetries = merged.remoteGit?.fetchRetries;
  if (typeof fetchRetries !== 'number' || !Number.isInteger(fetchRetries) || fetchRetries < 0) {
    throw new Error('remoteGit.fetchRetries 必须是非负整数');
  }

  for (const [field, label] of [
    ['shardChars', 'sharding.shardChars'],
    ['maxShards', 'sharding.maxShards'],
    ['maxConcurrency', 'sharding.maxConcurrency']
  ]) {
    const value = merged.sharding?.[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new Error(`${label} 必须是 >=1 的整数`);
    }
  }

  return merged;
}
