// Display formatters for sizes, durations, timestamps and counted nouns.

const PLACEHOLDER = '–';
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'];

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return PLACEHOLDER;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${BYTE_UNITS[unitIndex]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return PLACEHOLDER;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Local wall-clock time of an ISO timestamp, e.g. "14:03:12". */
export const formatTime = (timestamp) => new Date(timestamp).toLocaleTimeString();

/** The YYYY-MM-DD part of an ISO timestamp. */
export const formatDate = (isoTimestamp) => isoTimestamp.slice(0, 10);

export const pluralize = (count, singular, plural) => (count === 1 ? singular : plural);
