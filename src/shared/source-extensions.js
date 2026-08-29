const CPP_EXT = new Set(['.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx']);

export const SUPPORTED_EXTENSIONS = ['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx', '.java'];

export const EXCLUDED_DIR_NAMES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'reports', 'logs'
]);

export function languageFromFileName(name) {
  const ext = name.includes('.') ? `.${name.split('.').pop().toLowerCase()}` : '';
  if (ext === '.c') return 'C';
  if (CPP_EXT.has(ext)) return 'CPP';
  if (ext === '.java') return 'JAVA';
  return null;
}

export function shouldSkipDirName(name) {
  return EXCLUDED_DIR_NAMES.has(name);
}

export function isBinaryBuffer(buf) {
  return buf.includes(0);
}
