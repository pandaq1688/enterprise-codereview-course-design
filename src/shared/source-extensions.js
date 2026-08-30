const CPP_EXT = new Set(['.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs']);

export const SUPPORTED_EXTENSIONS = [
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx', '.java',
  '.js', '.mjs', '.cjs', '.py', '.go'
];

export const EXCLUDED_DIR_NAMES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'reports', 'logs',
  '__pycache__', '.venv', 'venv', 'vendor'
]);

export function languageFromFileName(name) {
  const ext = name.includes('.') ? `.${name.split('.').pop().toLowerCase()}` : '';
  if (ext === '.c') return 'C';
  if (CPP_EXT.has(ext)) return 'CPP';
  if (ext === '.java') return 'JAVA';
  if (JS_EXT.has(ext)) return 'JS';
  if (ext === '.py') return 'PYTHON';
  if (ext === '.go') return 'GO';
  return null;
}

export function shouldSkipDirName(name) {
  return EXCLUDED_DIR_NAMES.has(name);
}

export function isBinaryBuffer(buf) {
  return buf.includes(0);
}
