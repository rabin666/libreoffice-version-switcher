// Commands that put one LibreOffice version first on PATH for the current
// shell session only (nothing persistent is changed).

import path from 'node:path';
import { isWindows } from './platform.js';

export const SHELLS = ['powershell', 'cmd', 'bash', 'fish'];

/** "D:\a\b" -> "/d/a/b" for Git Bash / MSYS shells on Windows. */
export function toMsysPath(p) {
  return p.replace(/^([A-Za-z]):[\\/]?/, (m, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');
}

const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

export function envCommand(shell, programDir, { windows = isWindows } = {}) {
  switch (shell) {
    case 'powershell':
      return windows
        ? `$env:Path = ${psQuote(programDir + ';')} + $env:Path`
        : `$env:PATH = ${psQuote(programDir + ':')} + $env:PATH`;
    case 'cmd':
      return `set "PATH=${programDir};%PATH%"`;
    case 'bash':
      return `export PATH=${shQuote(windows ? toMsysPath(programDir) : programDir)}:"$PATH"`;
    case 'fish':
      return `set -gx PATH ${shQuote(windows ? toMsysPath(programDir) : programDir)} $PATH`;
    default:
      throw new Error(`Unknown shell "${shell}". Use one of: ${SHELLS.join(', ')}`);
  }
}

/** Shells that make sense on this OS, most likely first. */
export function shellsForPlatform(windows = isWindows) {
  return windows ? ['powershell', 'cmd', 'bash'] : ['bash', 'fish', 'powershell'];
}

export function envCommands(programDir, opts) {
  const windows = opts?.windows ?? isWindows;
  return Object.fromEntries(shellsForPlatform(windows).map((s) => [s, envCommand(s, programDir, { windows })]));
}

/** Best guess of the shell the user runs lovs from. */
export function detectShell(env = process.env) {
  if (env.LOVS_SHELL && SHELLS.includes(env.LOVS_SHELL)) return env.LOVS_SHELL;
  const sh = path.basename(env.SHELL || '').replace(/\.exe$/i, '');
  if (sh === 'fish') return 'fish';
  if (['bash', 'zsh', 'sh', 'dash', 'ksh'].includes(sh)) return 'bash';
  // cmd and PowerShell can't be told apart reliably from the environment.
  return isWindows ? 'powershell' : 'bash';
}

/** One-liners that apply the output of `lovs env` in the current shell. */
export function evalHint(shell, spec) {
  switch (shell) {
    case 'powershell':
      return `lovs env ${spec} --shell powershell | Invoke-Expression`;
    case 'cmd':
      return `for /f "delims=" %i in ('lovs env ${spec} --shell cmd') do %i`;
    case 'fish':
      return `lovs env ${spec} --shell fish | source`;
    default:
      return `eval "$(lovs env ${spec} --shell bash)"`;
  }
}
