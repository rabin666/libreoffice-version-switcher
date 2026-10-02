// Commands that put one LibreOffice version first on PATH for the current
// shell session only (nothing persistent is changed).

import fs from 'node:fs';
import path from 'node:path';
import { isWindows } from './platform.js';

export const SHELLS = ['powershell', 'cmd', 'bash', 'fish'];

/** "D:\a\b" -> "/d/a/b" for Git Bash / MSYS shells on Windows. */
export function toMsysPath(p) {
  return p.replace(/^([A-Za-z]):[\\/]?/, (m, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');
}

// Shell-specific quoting. Each returns text the shell reads back as exactly
// `s`: no variable, command or history expansion.
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
// fish single quotes treat \\ and \' as escapes, everything else literally.
const fishQuote = (s) => `'${s.replace(/[\\']/g, '\\$&')}'`;
// cmd has no escape that works inside quotes on an interactive command line
// (%VAR% always expands, and `call` doubles ^), so such text can't be passed.
const CMD_UNSAFE = /["%^!\r\n]/;
function cmdQuote(s) {
  if (CMD_UNSAFE.test(s)) throw new Error(`"${s}" contains characters (" % ^ !) that cmd.exe can't take literally`);
  return `"${s}"`;
}

/** `s` as a single literal argument for `shell`. */
export function shellArg(shell, s) {
  if (/^[\w.@:+-]+$/.test(s)) return s;
  switch (shell) {
    case 'powershell':
      return psQuote(s);
    case 'cmd':
      return cmdQuote(s);
    case 'fish':
      return fishQuote(s);
    default:
      return shQuote(s);
  }
}

export function envCommand(shell, programDir, { windows = isWindows } = {}) {
  switch (shell) {
    case 'powershell':
      return windows
        ? `$env:Path = ${psQuote(programDir + ';')} + $env:Path`
        : `$env:PATH = ${psQuote(programDir + ':')} + $env:PATH`;
    case 'cmd':
      if (CMD_UNSAFE.test(programDir)) throw new Error(`${programDir} contains characters (" % ^ !) that cmd.exe can't take literally`);
      return `set "PATH=${programDir};%PATH%"`;
    case 'bash':
      return `export PATH=${shQuote(windows ? toMsysPath(programDir) : programDir)}:"$PATH"`;
    case 'fish':
      return `set -gx PATH ${fishQuote(windows ? toMsysPath(programDir) : programDir)} $PATH`;
    default:
      throw new Error(`Unknown shell "${shell}". Use one of: ${SHELLS.join(', ')}`);
  }
}

/** Shells that make sense on this OS, most likely first. */
export function shellsForPlatform(windows = isWindows) {
  return windows ? ['powershell', 'cmd', 'bash'] : ['bash', 'fish', 'powershell'];
}

/** Commands for every shell of this OS; a shell that can't express `programDir` is left out. */
export function envCommands(programDir, opts) {
  const windows = opts?.windows ?? isWindows;
  const out = {};
  for (const s of shellsForPlatform(windows)) {
    try {
      out[s] = envCommand(s, programDir, { windows });
    } catch {
      // e.g. a % in the path for cmd
    }
  }
  return out;
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
  const arg = shellArg(shell, spec);
  switch (shell) {
    case 'powershell':
      return `lovs env ${arg} --shell powershell | Invoke-Expression`;
    case 'cmd':
      // `call` gives the line a second %-expansion pass: for /f substitutes
      // %i only after %PATH% has been expanded, so without it PATH would be
      // set to the literal text "...;%PATH%".
      return `for /f "delims=" %i in ('lovs env ${arg} --shell cmd') do call %i`;
    case 'fish':
      return `lovs env ${arg} --shell fish | source`;
    default:
      return `eval "$(lovs env ${arg} --shell bash)"`;
  }
}

/** Git for Windows' bash; never WSL's System32\bash.exe or the WindowsApps stub. */
function findWindowsBash(env) {
  const candidates = [env.EXEPATH && path.join(env.EXEPATH, 'bash.exe')];
  for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
    if (dir && !/\\(system32|windowsapps)\\?$/i.test(dir)) candidates.push(path.join(dir, 'bash.exe'));
  }
  for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)']]) if (pf) candidates.push(path.join(pf, 'Git', 'bin', 'bash.exe'));
  return candidates.filter(Boolean).find((c) => fs.existsSync(c)) ?? 'bash.exe';
}

/**
 * How to start an interactive sub-shell in which `programDir` comes first on
 * PATH. The PATH change is applied *after* the shell's own start-up files
 * (which may prepend a persistent default, e.g. lovs' own PATH hook), so the
 * selected version always wins.
 *
 * Returns {command, args, verbatim, env, files}; `files` (path -> content)
 * must be written into `tmpDir` before starting and removed afterwards.
 */
export function subshellPlan(shell, programDir, { env = process.env, windows = isWindows, tmpDir } = {}) {
  const plan = { args: [], verbatim: false, env: {}, files: {} };
  switch (shell) {
    case 'powershell':
      // -Command runs after the profile scripts; -NoExit keeps the shell open.
      return { ...plan, command: windows ? 'powershell.exe' : 'pwsh', args: ['-NoLogo', '-NoExit', '-Command', envCommand('powershell', programDir, { windows })] };
    case 'cmd':
      // /K runs after cmd's AutoRun; passed verbatim so cmd sees the set "..." as typed.
      return { ...plan, command: env.ComSpec || 'cmd.exe', args: ['/K', envCommand('cmd', programDir, { windows })], verbatim: true };
    case 'fish':
      // --init-command runs after config.fish and conf.d.
      return { ...plan, command: 'fish', args: ['--init-command', envCommand('fish', programDir, { windows })] };
    case 'bash': {
      if (!tmpDir) throw new Error('tmpDir is required for bash/zsh sub-shells');
      const activate = envCommand('bash', programDir, { windows });
      const command = windows ? findWindowsBash(env) : env.SHELL && /\/(ba|z)sh$/.test(env.SHELL) ? env.SHELL : 'bash';
      if (/zsh$/.test(command)) {
        // zsh has no --rcfile: point ZDOTDIR at wrappers that source the
        // user's own files first, then restore ZDOTDIR.
        const restore = env.ZDOTDIR ? `ZDOTDIR=${shQuote(env.ZDOTDIR)}` : 'unset ZDOTDIR';
        const orig = shQuote(env.ZDOTDIR || env.HOME || '~');
        plan.files[path.join(tmpDir, '.zshenv')] = `${restore}\n[ -f ${orig}/.zshenv ] && . ${orig}/.zshenv\nZDOTDIR=${shQuote(tmpDir)}\n`;
        plan.files[path.join(tmpDir, '.zshrc')] = `${restore}\n[ -f ${orig}/.zshrc ] && . ${orig}/.zshrc\n${activate}\n`;
        return { ...plan, command, args: ['-i'], env: { ZDOTDIR: tmpDir } };
      }
      const rcfile = path.join(tmpDir, 'bashrc');
      plan.files[rcfile] = `[ -f ~/.bashrc ] && . ~/.bashrc\n${activate}\n`;
      return { ...plan, command, args: ['--rcfile', windows ? toMsysPath(rcfile) : rcfile, '-i'] };
    }
    default:
      throw new Error(`Unknown shell "${shell}". Use one of: ${SHELLS.join(', ')}`);
  }
}
