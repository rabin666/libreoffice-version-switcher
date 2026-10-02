// Persistent PATH (what new terminals get), per scope:
//
//   Windows  user: HKCU\Environment\Path   machine: HKLM\...\Session Manager\Environment\Path
//            Written as REG_EXPAND_SZ so %VAR% entries survive; machine scope
//            elevates through UAC when needed.
//   Linux    user: ~/.config/lovs/path.sh (sourced from the shell rc files)
//            machine: /etc/profile.d/lovs.sh (needs root)

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside, normalizePath } from './fsutil.js';
import { isProgramDir } from './local.js';
import { isWindows } from './platform.js';

export const SCOPES = ['user', 'machine'];
const PATH_SEPARATOR = isWindows ? ';' : ':';

// ---------------------------------------------------------------- entries

export function splitPath(value) {
  return String(value ?? '')
    .split(PATH_SEPARATOR)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Expand %VAR% (Windows) or ~ / $VAR (Linux) in one PATH entry. */
export function expandEnv(entry, env = process.env) {
  if (isWindows) {
    const lookup = (name) => {
      const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      return key ? env[key] : undefined;
    };
    return entry.replace(/%([^%]+)%/g, (placeholder, name) => lookup(name) ?? placeholder);
  }
  return entry
    .replace(/^~(?=$|\/)/, os.homedir())
    .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (placeholder, name) => env[name] ?? placeholder);
}

export function samePath(a, b) {
  return normalizePath(expandEnv(a)) === normalizePath(expandEnv(b));
}

const isLibreOfficeEntry = (entry) => isProgramDir(expandEnv(entry));

/** `dir` first, without duplicates; by default other LibreOffice folders are dropped. */
export function withEntryAdded(entries, dir, { replaceLibreOffice = true, isLibreOffice = isLibreOfficeEntry } = {}) {
  const removed = [];
  const kept = entries.filter((entry) => {
    if (samePath(entry, dir)) return false;
    if (replaceLibreOffice && isLibreOffice(entry)) {
      removed.push(entry);
      return false;
    }
    return true;
  });
  return { entries: [dir, ...kept], removed };
}

export function withEntriesRemoved(entries, shouldRemove) {
  return { entries: entries.filter((entry) => !shouldRemove(entry)), removed: entries.filter(shouldRemove) };
}

/** First PATH entry providing `soffice` (honours PATHEXT on Windows): {dir, file, realPath}. */
export function whichSoffice(pathValue = process.env.PATH ?? process.env.Path ?? '') {
  const extensions = isWindows ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of splitPath(pathValue)) {
    for (const extension of extensions) {
      const file = path.join(expandEnv(dir), `soffice${extension.toLowerCase()}`);
      try {
        if (!fs.statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      let resolved = file;
      try {
        resolved = fs.realpathSync(file);
      } catch {
        // keep the unresolved path
      }
      return { dir, file, realPath: resolved };
    }
  }
  return null;
}

// ---------------------------------------------------------------- Windows

const MACHINE_ENV_KEY = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const psQuote = (text) => `'${String(text).replace(/'/g, "''")}'`;
const encodeForPowerShell = (script) => Buffer.from(script, 'utf16le').toString('base64');

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeForPowerShell(script)],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        // First meaningful line, without PowerShell's position/category noise.
        const message = String(stderr || err.message)
          .split(/\r?\n/)
          .find((line) => line.trim() && !/^\s*(At line|\+|CategoryInfo|FullyQualifiedErrorId)/.test(line));
        reject(new Error(message?.trim() || err.message));
      },
    );
  });
}

/** Raw (unexpanded) user and machine Path values, and whether we run elevated. */
async function readWindowsPaths() {
  const output = await runPowerShell(`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$user = (Get-Item 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$machine = (Get-Item 'HKLM:\\${MACHINE_ENV_KEY}').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
@{ user = [string]$user; machine = [string]$machine; admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress
`);
  return JSON.parse(output.trim());
}

async function writeWindowsPath(scope, value, isAdmin) {
  const openKey = scope === 'machine' ? `LocalMachine.OpenSubKey(${psQuote(MACHINE_ENV_KEY)}, $true)` : `CurrentUser.OpenSubKey('Environment', $true)`;
  const writeScript = `
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::${openKey}
if ($null -eq $key) { throw 'Cannot open the environment registry key for writing' }
$key.SetValue('Path', ${psQuote(value)}, [Microsoft.Win32.RegistryValueKind]::ExpandString)
$key.Close()
# Clearing a user variable makes .NET broadcast WM_SETTINGCHANGE, so new terminals see the change.
[Environment]::SetEnvironmentVariable('LOVS_ENV_REFRESH', $null, 'User')
`;
  if (scope !== 'machine' || isAdmin) {
    await runPowerShell(writeScript);
    return;
  }
  try {
    await runPowerShell(`
$ErrorActionPreference = 'Stop'
$process = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encodeForPowerShell(writeScript)}'
exit $process.ExitCode
`);
  } catch (err) {
    if (/cancel/i.test(err.message)) throw new Error('Administrator permission was declined (UAC prompt cancelled)');
    throw err;
  }
}

// ---------------------------------------------------------------- Linux

const HOOK_START = '# >>> lovs (libreoffice-version-switcher) >>>';
const HOOK_END = '# <<< lovs <<<';
const shQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

export function linuxPathFile(scope) {
  if (scope === 'machine') return '/etc/profile.d/lovs.sh';
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'lovs', 'path.sh');
}

export function renderLinuxPathFile(entries) {
  // Prepended in reverse, so entries[0] ends up first on PATH.
  const prependLines = [...entries].reverse().map((entry) => `lovs_prepend ${shQuote(entry)}`);
  return [
    '# Managed by lovs (libreoffice-version-switcher). This file is rewritten by `lovs path`.',
    'lovs_prepend() { case ":$PATH:" in *":$1:"*) ;; *) PATH="$1:$PATH" ;; esac; }',
    ...prependLines,
    'export PATH',
    'unset -f lovs_prepend',
    '',
  ].join('\n');
}

export function parseLinuxPathFile(text) {
  const entries = [];
  for (const line of String(text).split('\n')) {
    const match = line.match(/^lovs_prepend '(.*)'$/);
    if (match) entries.push(match[1].replace(/'\\''/g, "'"));
  }
  return entries.reverse();
}

function readLinuxPathFile(scope) {
  try {
    return parseLinuxPathFile(fs.readFileSync(linuxPathFile(scope), 'utf8'));
  } catch {
    return [];
  }
}

/** Make the user's shell rc files source path.sh; returns the files changed. */
function installShellHooks(pathFile) {
  const home = os.homedir();
  const rcFiles = ['.bashrc', '.profile'].map((name) => path.join(home, name));
  for (const optional of ['.zshrc', '.bash_profile', '.bash_login']) {
    const rcFile = path.join(home, optional);
    if (fs.existsSync(rcFile)) rcFiles.push(rcFile);
  }
  const hook = `${HOOK_START}\n[ -f ${shQuote(pathFile)} ] && . ${shQuote(pathFile)}\n${HOOK_END}\n`;
  const changed = [];
  for (const rcFile of rcFiles) {
    let text = '';
    try {
      text = fs.readFileSync(rcFile, 'utf8');
    } catch {
      // created below
    }
    if (text.includes(HOOK_START)) continue;
    fs.appendFileSync(rcFile, `${text && !text.endsWith('\n') ? '\n' : ''}\n${hook}`);
    changed.push(rcFile);
  }
  return changed;
}

function writeLinuxPathFile(scope, entries) {
  const file = linuxPathFile(scope);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderLinuxPathFile(entries), { mode: 0o644 });
  } catch (err) {
    if (scope === 'machine' && (err.code === 'EACCES' || err.code === 'EPERM')) throw new Error(`Writing ${file} needs root. Re-run with sudo.`);
    throw err;
  }
  return scope === 'user' ? installShellHooks(file) : [];
}

// ---------------------------------------------------------------- public API

async function readScopes() {
  if (isWindows) {
    const raw = await readWindowsPaths();
    return { isAdmin: raw.admin, user: splitPath(raw.user), machine: splitPath(raw.machine) };
  }
  const isAdmin = typeof process.getuid === 'function' && process.getuid() === 0;
  return { isAdmin, user: readLinuxPathFile('user'), machine: readLinuxPathFile('machine') };
}

/** Persist one scope; returns the shell rc files that were hooked (Linux user scope). */
async function writeScope(scope, entries, isAdmin) {
  if (!isWindows) return writeLinuxPathFile(scope, entries);
  await writeWindowsPath(scope, entries.join(';'), isAdmin);
  return [];
}

function assertScope(scope) {
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of: ${SCOPES.join(', ')}`);
}

const describeEntries = (entries) => entries.map((entry) => ({ entry, expanded: expandEnv(entry), libreoffice: isLibreOfficeEntry(entry) }));

/**
 * LibreOffice-related PATH state: entries per scope, which program folder
 * new terminals pick up (`newShells`), and which soffice this process sees (`current`).
 */
export async function getPathStatus() {
  const scopes = await readScopes();
  // Windows builds a new shell's PATH as machine + user; Linux sources
  // /etc/profile.d before ~/.profile, which leaves user entries in front.
  const searchOrder = isWindows
    ? [...scopes.machine.map((entry) => [entry, 'machine']), ...scopes.user.map((entry) => [entry, 'user'])]
    : [...scopes.user.map((entry) => [entry, 'user']), ...scopes.machine.map((entry) => [entry, 'machine'])];
  const winner = searchOrder.find(([entry]) => isLibreOfficeEntry(entry));
  return {
    admin: scopes.isAdmin,
    scopes: {
      user: { entries: describeEntries(scopes.user), location: isWindows ? 'HKCU\\Environment\\Path' : linuxPathFile('user') },
      machine: { entries: describeEntries(scopes.machine), location: isWindows ? `HKLM\\${MACHINE_ENV_KEY}\\Path` : linuxPathFile('machine') },
    },
    newShells: winner ? { programDir: expandEnv(winner[0]), scope: winner[1] } : null,
    current: whichSoffice(),
  };
}

/** {user, machine, newShells, current}: where `install` appears in a status snapshot. */
export function pathFlagsFor(install, status) {
  const programDir = install.programDir;
  const inScope = (scope) => status.scopes[scope].entries.some((item) => samePath(item.entry, programDir));
  const current = status.current;
  return {
    user: inScope('user'),
    machine: inScope('machine'),
    newShells: Boolean(status.newShells && samePath(status.newShells.programDir, programDir)),
    current: Boolean(current && (samePath(current.dir, programDir) || isInside(current.realPath, install.root))),
  };
}

function shadowWarnings(status, programDir) {
  if (!status.newShells || samePath(status.newShells.programDir, programDir)) return [];
  const { programDir: winnerDir, scope } = status.newShells;
  const advice =
    isWindows && scope === 'machine'
      ? 'Windows puts the machine PATH before the user PATH: remove it with "lovs path remove --scope machine" or add this version with "--scope machine".'
      : 'Remove it to make this version active.';
  return [`${winnerDir} (${scope} PATH) still comes first in new shells. ${advice}`];
}

/** Put the install's program folder first on the persistent PATH of `scope`. */
export async function addToPath(install, { scope = 'user', replace = true } = {}) {
  assertScope(scope);
  const scopes = await readScopes();
  const { entries, removed } = withEntryAdded(scopes[scope], install.programDir, { replaceLibreOffice: replace });
  const hooks = await writeScope(scope, entries, scopes.isAdmin);
  const status = await getPathStatus();
  return { scope, added: install.programDir, removed, hooks, warnings: shadowWarnings(status, install.programDir), status };
}

/** Remove one install's folder (or every LibreOffice folder) from `scope`. */
export async function removeFromPath({ scope = 'user', install = null } = {}) {
  assertScope(scope);
  const scopes = await readScopes();
  // Every entry in lovs' own Linux file is LibreOffice's, even if its folder
  // is gone; on Windows they have to be recognised.
  const shouldRemove = install ? (entry) => samePath(entry, install.programDir) : isWindows ? isLibreOfficeEntry : () => true;
  const { entries, removed } = withEntriesRemoved(scopes[scope], shouldRemove);
  if (removed.length) await writeScope(scope, entries, scopes.isAdmin);
  return { scope, removed, status: await getPathStatus() };
}
