// Terminal output: messages, aligned tables, byte/time formatting, progress bar.

import pc from 'picocolors';

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'];
const PROGRESS_BAR_WIDTH = 24;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPES = /\x1b\[[0-9;]*m/g;

export const ok = (message) => console.log(`${pc.green('✔')} ${message}`);
export const warn = (message) => console.error(`${pc.yellow('!')} ${message}`);
export const info = (message) => console.log(`${pc.cyan('›')} ${message}`);

export const printJson = (data) => console.log(JSON.stringify(data, null, 2));
export const printWarnings = (warnings) => warnings?.forEach(warn);

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '?';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${BYTE_UNITS[unit]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

const visibleLength = (text) => String(text).replace(ANSI_ESCAPES, '').length;

/** Rows (arrays of cells, colours allowed) as aligned columns under a dim header. */
export function table(headers, rows) {
  const widths = headers.map((header, column) => Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[column] ?? ''))));
  const formatRow = (cells) =>
    cells
      .map((cell, column) => {
        const text = String(cell ?? '');
        const isLast = column === cells.length - 1;
        return isLast ? text : text + ' '.repeat(widths[column] - visibleLength(text));
      })
      .join('  ');
  return [pc.dim(formatRow(headers)), ...rows.map(formatRow)].join('\n');
}

function describeProgress({ downloaded, total, speed, external }) {
  const sizeText = `${formatBytes(downloaded)}${total ? ` / ${formatBytes(total)}` : ''}`;
  if (external === 'xdm') {
    return downloaded ? `XDM is writing the file: ${sizeText}` : 'Waiting for XDM to finish the download (progress is shown in XDM)';
  }
  const percent = total ? Math.min(100, (downloaded / total) * 100) : null;
  const filled = percent == null ? 0 : Math.round((percent / 100) * PROGRESS_BAR_WIDTH);
  const bar = pc.cyan('█'.repeat(filled)) + pc.dim('░'.repeat(PROGRESS_BAR_WIDTH - filled));
  const eta = total && speed > 0 ? formatDuration((total - downloaded) / speed) : '--';
  const percentText = percent == null ? '' : `${percent.toFixed(0).padStart(3)}% `;
  return `${bar} ${percentText}${sizeText}  ${formatBytes(speed)}/s  ETA ${eta}`;
}

/** One updating line on stderr; without a TTY, a line every 10%. */
export function progressBar(label) {
  const isTty = process.stderr.isTTY;
  let lastReportedPercent = -10;
  let lastLine = '';
  return {
    update(progress) {
      if (isTty) {
        const line = `  ${label} ${describeProgress(progress)}`;
        const padding = ' '.repeat(Math.max(0, visibleLength(lastLine) - visibleLength(line)));
        process.stderr.write(`\r${line}${padding}`);
        lastLine = line;
        return;
      }
      const percent = progress.total ? Math.min(100, (progress.downloaded / progress.total) * 100) : null;
      if (percent != null && percent - lastReportedPercent >= 10) {
        lastReportedPercent = percent;
        process.stderr.write(`  ${label} ${percent.toFixed(0)}%\n`);
      }
    },
    /** End the progress line so normal output can follow. */
    done() {
      if (isTty && lastLine) process.stderr.write('\n');
      lastLine = '';
    },
  };
}
