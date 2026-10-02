import pc from 'picocolors';

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m${String(Math.round(sec % 60)).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLength = (s) => String(s).replace(ANSI_RE, '').length;

/** Render rows (arrays of strings) as aligned columns with a dim header. */
export function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ''))));
  const line = (cells) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? String(c ?? '') : String(c ?? '') + ' '.repeat(widths[i] - visibleLength(c ?? ''))))
      .join('  ');
  return [pc.dim(line(headers)), ...rows.map(line)].join('\n');
}

/** Single-line progress bar on stderr (falls back to occasional lines when not a TTY). */
export function progressBar(label) {
  const tty = process.stderr.isTTY;
  let lastPct = -10;
  let lastLine = '';
  return {
    update({ downloaded, total, speed, external }) {
      const pct = total ? Math.min(100, (downloaded / total) * 100) : null;
      let text;
      if (external === 'xdm') {
        text = downloaded
          ? `XDM is writing the file: ${formatBytes(downloaded)}${total ? ` / ${formatBytes(total)}` : ''}`
          : 'Waiting for XDM to finish the download (progress is shown in XDM)';
      } else {
        const width = 24;
        const filled = pct == null ? 0 : Math.round((pct / 100) * width);
        const bar = pc.cyan('█'.repeat(filled)) + pc.dim('░'.repeat(width - filled));
        const eta = total && speed > 0 ? formatDuration((total - downloaded) / speed) : '--';
        text = `${bar} ${pct == null ? '' : `${pct.toFixed(0).padStart(3)}% `}${formatBytes(downloaded)}${total ? ` / ${formatBytes(total)}` : ''}  ${formatBytes(speed)}/s  ETA ${eta}`;
      }
      if (tty) {
        const line = `  ${label} ${text}`;
        process.stderr.write(`\r${line}${' '.repeat(Math.max(0, visibleLength(lastLine) - visibleLength(line)))}`);
        lastLine = line;
      } else if (pct != null && pct - lastPct >= 10) {
        lastPct = pct;
        process.stderr.write(`  ${label} ${pct.toFixed(0)}%\n`);
      }
    },
    done() {
      if (tty && lastLine) process.stderr.write('\n');
      lastLine = '';
    },
  };
}

export const ok = (msg) => console.log(`${pc.green('✔')} ${msg}`);
export const warn = (msg) => console.error(`${pc.yellow('!')} ${msg}`);
export const info = (msg) => console.log(`${pc.cyan('›')} ${msg}`);
