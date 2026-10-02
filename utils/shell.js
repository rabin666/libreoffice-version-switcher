// Per-session activation: commands that put one LibreOffice version first on
// PATH for a single terminal (nothing persistent changes), shell-safe quoting,
// and how to launch a sub-shell with a version active.

import fs from 'node:fs';
import path from 'node:path';
import { isWindows } from './platform.js';

export const SHELLS = ['powershell', 'cmd', 'bash', 'fish'];

/** "D:\a\b" -> "/d/a/b" for Git Bash / MSYS on Windows. */
export function toMsysPath(windowsPath) {
  return windowsPath.replace(/^([A-Za-z]):[\\/]?/, (match, drive) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/');
}

// ---------------------------------------------------------------- quoting
// Each returns text the shell reads back as exactly the input: no variable,
// command or history expansion.

const psQuote = (text) => `'${text.replace(/'/g, "''")}'`;
const posixQuote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
// fish single quotes treat \\ and \' as escapes and everything else literally.
const fishQuote = (text) => `'${text.replace(/[\\']/g, '\\$&')}'`;

// cmd has no escape that works inside quotes on an interactive line (%VAR%
// always expands, and `call` doubles ^), so such text is refused.
const CMD_UNSAFE = /["%^!\r\n]/;

function assertCmdSafe(text) {
  if (CMD_UNSAFE.test(text)) throw new Error(`"${text}" contains characters (" % ^ !) that cmd.exe can't take literally`);
}

/** `text` as one literal argument for `shell`. */
export function quoteArg(shell, text) {
  if (/^[\w.@:+-]+$/.test(text)) return text;
  switch (shell) {
    case 'powershell':
      return psQuote(text);
    case 'cmd':
      assertCmdSafe(text);
      return `"${text}"`;
    case 'fish':
      return fishQuote(text);
    default:
      return posixQuote(text);
  }
}

// ---------------------------------------------------------------- activation

/** The command that prepends `programDir` to PATH in `shell`. */
export function activationCommand(shell, programDir, { windows = isWindows } = {}) {
  const shellPath = windows ? toMsysPath(programDir) : programDir;
  switch (shell) {
    case 'powershell':
      return windows ? `$env:Path = ${psQuote(`${programDir};`)} + $env:Path` : `$env:PATH = ${psQuote(`${programDir}:`)} + $env:PATH`;
    case 'cmd':
      assertCmdSafe(programDir);
      return `set "PATH=${programDir};%PATH%"`;
    case 'bash':
      return `export PATH=${posixQuote(shellPath)}:"$PATH"`;
    case 'fish':
      return `set -gx PATH ${fishQuote(shellPath)} $PATH`;
    default:
      throw new Error(`Unknown shell "${shell}". Use one of: ${SHELLS.join(', ')}`);
  }
}

/** Shells that make sense on this OS, most likely first. */
export function shellsForPlatform(windows = isWindows) {
  return windows ? ['powershell', 'cmd', 'bash'] : ['bash', 'fish', 'powershell'];
}

/** {shell: command} for this OS; a shell that can't express `programDir` is left out. */
export function activationCommands(programDir, { windows = isWindows } = {}) {
  const commands = {};
  for (const shell of shellsForPlatform(windows)) {
    try {
      commands[shell] = activationCommand(shell, programDir, { windows });
    } catch {
      // e.g. a % in the path for cmd
    }
  }
  return commands;
}

/** Best guess of the shell lovs runs in. cmd and PowerShell can't be told apart; PowerShell wins. */
export function detectShell(env = process.env) {
  if (env.LOVS_SHELL && SHELLS.includes(env.LOVS_SHELL)) return env.LOVS_SHELL;
  const shellName = path.basename(env.SHELL || '').replace(/\.exe$/i, '');
  if (shellName === 'fish') return 'fish';
  if (['bash', 'zsh', 'sh', 'dash', 'ksh'].includes(shellName)) return 'bash';
  return isWindows ? 'powershell' : 'bash';
}

/** One-liner that runs `lovs env <selector>` and applies its output in `shell`. */
export function activationOneLiner(shell, selector) {
  const arg = quoteArg(shell, selector);
  switch (shell) {
    case 'powershell':
      return `lovs env ${arg} --shell powershell | Invoke-Expression`;
    case 'cmd':
      // `call` adds a second %-expansion pass: for /f substitutes %i only
      // after %PATH% was expanded, which would leave PATH as literal "...;%PATH%".
      return `for /f "delims=" %i in ('lovs env ${arg} --shell cmd') do call %i`;
    case 'fish':
      return `lovs env ${arg} --shell fish | source`;
    default:
      return `eval "$(lovs env ${arg} --shell bash)"`;
  }
}

// ---------------------------------------------------------------- sub-shells

/** Git for Windows' bash; never WSL's System32\bash.exe or the WindowsApps stub. */
function findWindowsBash(env) {
  const candidates = [env.EXEPATH && path.join(env.EXEPATH, 'bash.exe')];
  for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
    if (dir && !/\\(system32|windowsapps)\\?$/i.test(dir)) candidates.push(path.join(dir, 'bash.exe'));
  }
  for (const programFiles of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (programFiles) candidates.push(path.join(programFiles, 'Git', 'bin', 'bash.exe'));
  }
  return candidates.filter(Boolean).find((candidate) => fs.existsSync(candidate)) ?? 'bash.exe';
}

function posixShellCommand(env, windows) {
  if (windows) return findWindowsBash(env);
  return env.SHELL && /\/(ba|z)sh$/.test(env.SHELL) ? env.SHELL : 'bash';
}

/** zsh has no --rcfile: a temporary ZDOTDIR sources the user's files first, then activates. */
function zshPlan(command, activate, env, tmpDir) {
  const restoreZdotdir = env.ZDOTDIR ? `ZDOTDIR=${posixQuote(env.ZDOTDIR)}` : 'unset ZDOTDIR';
  const userDir = posixQuote(env.ZDOTDIR || env.HOME || '~');
  return {
    command,
    args: ['-i'],
    verbatim: false,
    env: { ZDOTDIR: tmpDir },
    files: {
      [path.join(tmpDir, '.zshenv')]: `${restoreZdotdir}\n[ -f ${userDir}/.zshenv ] && . ${userDir}/.zshenv\nZDOTDIR=${posixQuote(tmpDir)}\n`,
      [path.join(tmpDir, '.zshrc')]: `${restoreZdotdir}\n[ -f ${userDir}/.zshrc ] && . ${userDir}/.zshrc\n${activate}\n`,
    },
  };
}

function bashPlan(command, activate, tmpDir, windows) {
  const rcFile = path.join(tmpDir, 'bashrc');
  return {
    command,
    args: ['--rcfile', windows ? toMsysPath(rcFile) : rcFile, '-i'],
    verbatim: false,
    env: {},
    files: { [rcFile]: `[ -f ~/.bashrc ] && . ~/.bashrc\n${activate}\n` },
  };
}

/**
 * How to start an interactive `shell` with `programDir` first on PATH. The
 * change is applied after the shell's own start-up files, which may prepend
 * a persistent default (e.g. lovs' PATH hook), so the selection always wins.
 *
 * Returns {command, args, verbatim, env, files}; write `files` (path -> content,
 * inside `tmpDir`) before starting and delete them afterwards.
 */
export function subshellLaunchPlan(shell, programDir, { env = process.env, windows = isWindows, tmpDir } = {}) {
  const base = { args: [], verbatim: false, env: {}, files: {} };
  switch (shell) {
    case 'powershell':
      // -Command runs after the profile scripts; -NoExit keeps the shell open.
      return { ...base, command: windows ? 'powershell.exe' : 'pwsh', args: ['-NoLogo', '-NoExit', '-Command', activationCommand('powershell', programDir, { windows })] };
    case 'cmd':
      // /K runs after AutoRun; verbatim so cmd sees `set "..."` exactly as typed.
      return { ...base, command: env.ComSpec || 'cmd.exe', args: ['/K', activationCommand('cmd', programDir, { windows })], verbatim: true };
    case 'fish':
      // --init-command runs after config.fish and conf.d.
      return { ...base, command: 'fish', args: ['--init-command', activationCommand('fish', programDir, { windows })] };
    case 'bash': {
      if (!tmpDir) throw new Error('tmpDir is required for bash/zsh sub-shells');
      const command = posixShellCommand(env, windows);
      const activate = activationCommand('bash', programDir, { windows });
      return /zsh$/.test(command) ? zshPlan(command, activate, env, tmpDir) : bashPlan(command, activate, tmpDir, windows);
    }
    default:
      throw new Error(`Unknown shell "${shell}". Use one of: ${SHELLS.join(', ')}`);
  }
}
