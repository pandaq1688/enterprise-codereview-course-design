/**
 * @param {string} text
 * @returns {string}
 */
export function numberLines(text) {
  const lines = text.split('\n');
  return lines.map((line, i) => `${String(i + 1).padStart(6, ' ')}|${line}`).join('\n');
}
