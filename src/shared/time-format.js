/**
 * Format an ISO 8601 timestamp (UTC) as a local-time string for display.
 *
 * The system stores all timestamps as UTC ISO strings (e.g.
 * `2026-08-30T08:03:28.632Z`). Displaying them raw confuses users in non-UTC
 * timezones, so the UI renders them in the server's local time with a trailing
 * UTC offset so the origin stays unambiguous.
 *
 * @param {unknown} value - anything Date can parse; null/undefined/empty -> ''
 * @returns {string} `YYYY-MM-DD HH:mm:ss` in local time, or '' when unparseable
 */
export function formatLocalTime(value) {
  if (value === null || value === undefined || value === '') return '';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return String(value);
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(offset) / 60));
  const om = pad(Math.abs(offset) % 60);
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} (UTC${sign}${oh}:${om})`;
}
