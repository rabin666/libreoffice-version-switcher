// Persistent PATH management.
//
// Windows: the user (HKCU) or machine (HKLM) "Path" registry value, written as
//          REG_EXPAND_SZ so entries like %USERPROFILE%\bin keep working.
//          Machine scope triggers a UAC prompt when not already elevated.
// Linux:   a small script lovs owns (~/.config/lovs/path.sh for the user,
//          /etc/profile.d/lovs.sh for the machine) that shells source on start.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside, isProgramDir, normalizePath } from './local.js';
import { isWindows } from './platform.js';

export const SCOPES = ['user', 'machine'];
const SEP = isWindows ? ';' : ':';

// ---------------------------------------------------------------- helpers

export function splitPath(raw) {
  return String(raw ?? '')
    .split(SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function expandEnv(entry, env = process.env) {
  if (isWindows) {
    const lookup = (name) => {
      const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
      return key ? env[key] : undefined;
    };
    return entry.replace(/%([^%]+)%/g, (m, name) => lookup(name) ?? m);
  }
  return entry
    .replace(/^~(?=$|\/)/, os.homedir())
    .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => env[name] ?? m);
}

export function samePath(a, b) {
  return normalizePath(expandEnv(a)) === normalizePath(expandEnv(b));
}

const isLoEntry = (entry) => isProgramDir(expandEnv(entry));

/** Put `dir` first; optionally drop every other LibreOffice program dir. */
export function withEntryAdded(entries, dir, { replaceLibreOffice = true, isLo = isLoEntry } = {}) {
  const removed = [];
  const kept = entries.filter((e) => {
    if (samePath(e, dir)) return false;
    if (replaceLibreOffice && isLo(e)) {
      removed.push(e);
      return false;
    }
    return true;
  });
  return { entries: [dir, ...kept], removed };
}

export function withEntriesRemoved(entries, predicate) {
  const removed = entries.filter(predicate);
  return { entries: entries.filter((e) => !predicate(e)), removed };
}

/** First PATH entry that provides `soffice` (follows PATHEXT on Windows). */
export function whichSoffice(pathValue = process.env.PATH ?? process.env.Path ?? '') {
  const exts = isWindows ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of splitPath(pathValue)) {
    for (const ext of exts) {
      const file = path.join(expandEnv(dir), `soffice${ext.toLowerCase()}`);
      try {
        if (fs.statSync(file).isFile()) {
          let real = file;
          try {
            real = fs.realpathSync(file);
          } catch {
            // keep unresolved path
          }
          return { dir, file, realPath: real };
        }
      } catch {
        // not here
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- Windows

function encodePs(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(script)],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message)
            .split(/\r?\n/)
            .find((l) => l.trim() && !/^\s*(At line|\+|CategoryInfo|FullyQualifiedErrorId)/.test(l));
          reject(new Error(msg?.trim() || err.message));
        } else resolve(String(stdout));
      },
    );
  });
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const MACHINE_KEY = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

async function readWindows() {
  const out = await runPowerShell(`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$u = (Get-Item 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$m = (Get-Item 'HKLM:\\${MACHINE_KEY}').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
@{ user = [string]$u; machine = [string]$m; admin = $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress
`);
  return JSON.parse(out.trim());
}

async function writeWindows(scope, value, admin) {
  const hive = scope === 'machine' ? `LocalMachine.OpenSubKey(${psQuote(MACHINE_KEY)}, $true)` : `CurrentUser.OpenSubKey('Environment', $true)`;
  const inner = `
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::${hive}
if ($null -eq $key) { throw 'Cannot open the environment registry key for writing' }
$key.SetValue('Path', ${psQuote(value)}, [Microsoft.Win32.RegistryValueKind]::ExpandString)
$key.Close()
# Deleting a (non-existent) user variable makes .NET broadcast WM_SETTINGCHANGE,
# so Explorer and newly opened terminals pick up the new PATH.
[Environment]::SetEnvironmentVariable('LOVS_ENV_REFRESH', $null, 'User')
`;
  if (scope !== 'machine' || admin) {
    await runPowerShell(inner);
    return;
  }
  try {
    await runPowerShell(`
$ErrorActionPreference = 'Stop'
$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encodePs(inner)}'
exit $p.ExitCode
`);
  } catch (err) {
    if (/cancel/i.test(err.message)) throw new Error('Administrator permission was declined (UAC prompt cancelled)');
    throw err;
  }
}

// ---------------------------------------------------------------- Linux

const MARK_START = '# >>> lovs (libreoffice-version-switcher) >>>';
const MARK_END = '# <<< lovs <<<';

export function linuxPathFile(scope) {
  if (scope === 'machine') return '/etc/profile.d/lovs.sh';
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'lovs', 'path.sh');
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function renderLinuxPathFile(entries) {
  // Prepend in reverse so entries[0] ends up first on PATH.
  const lines = [...entries].reverse().map((e) => `lovs_prepend ${shQuote(e)}`);
  return [
    '# Managed by lovs (libreoffice-version-switcher). This file is rewritten by `lovs path`.',
    'lovs_prepend() { case ":$PATH:" in *":$1:"*) ;; *) PATH="$1:$PATH" ;; esac; }',
    ...lines,
    'export PATH',
    'unset -f lovs_prepend',
    '',
  ].join('\n');
}

export function parseLinuxPathFile(text) {
  const entries = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^lovs_prepend '(.*)'$/);
    if (m) entries.push(m[1].replace(/'\\''/g, "'"));
  }
  return entries.reverse();
}

function readLinux(scope) {
  try {
    return parseLinuxPathFile(fs.readFileSync(linuxPathFile(scope), 'utf8'));
  } catch {
    return [];
  }
}

/** Make the user's shell start-up files source ~/.config/lovs/path.sh. */
function ensureShellHooks(file) {
  const home = os.homedir();
  const rcFiles = ['.bashrc', '.profile'].map((f) => path.join(home, f));
  for (const extra of ['.zshrc', '.bash_profile', '.bash_login']) {
    const p = path.join(home, extra);
    if (fs.existsSync(p)) rcFiles.push(p);
  }
  const block = `${MARK_START}\n[ -f ${shQuote(file)} ] && . ${shQuote(file)}\n${MARK_END}\n`;
  const touched = [];
  for (const rc of rcFiles) {
    let text = '';
    try {
      text = fs.readFileSync(rc, 'utf8');
    } catch {
      // will be created
    }
    if (text.includes(MARK_START)) continue;
    fs.appendFileSync(rc, `${text && !text.endsWith('\n') ? '\n' : ''}\n${block}`);
    touched.push(rc);
  }
  return touched;
}

function writeLinux(scope, entries) {
  const file = linuxPathFile(scope);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderLinuxPathFile(entries), { mode: 0o644 });
  } catch (err) {
    if (scope === 'machine' && (err.code === 'EACCES' || err.code === 'EPERM')) {
      throw new Error(`Writing ${file} needs root. Re-run with sudo.`);
    }
    throw err;
  }
  return scope === 'user' ? ensureShellHooks(file) : [];
}

// ---------------------------------------------------------------- public API

async function readScopes() {
  if (isWindows) {
    const r = await readWindows();
    return { admin: r.admin, user: splitPath(r.user), machine: splitPath(r.machine) };
  }
  const admin = typeof process.getuid === 'function' && process.getuid() === 0;
  return { admin, user: readLinux('user'), machine: readLinux('machine') };
}

async function writeScope(scope, entries, admin) {
  if (isWindows) {
    await writeWindows(scope, entries.join(';'), admin);
    return [];
  }
  return writeLinux(scope, entries);
}

function describeEntries(entries) {
  return entries.map((entry) => ({ entry, expanded: expandEnv(entry), libreoffice: isLoEntry(entry) }));
}

/**
 * Snapshot of LibreOffice-related PATH state:
 *  - per scope entries (persistent)
 *  - which program dir new shells will pick up
 *  - which soffice this process currently resolves
 */
export async function getPathStatus() {
  const s = await readScopes();
  // Windows builds a new shell's PATH as machine + user; Linux runs
  // /etc/profile.d first and then ~/.profile, so user entries end up in front.
  const order = isWindows
    ? [...s.machine.map((e) => [e, 'machine']), ...s.user.map((e) => [e, 'user'])]
    : [...s.user.map((e) => [e, 'user']), ...s.machine.map((e) => [e, 'machine'])];
  const first = order.find(([e]) => isLoEntry(e));
  return {
    admin: s.admin,
    scopes: {
      user: { entries: describeEntries(s.user), location: isWindows ? 'HKCU\\Environment\\Path' : linuxPathFile('user') },
      machine: {
        entries: describeEntries(s.machine),
        location: isWindows ? `HKLM\\${MACHINE_KEY}\\Path` : linuxPathFile('machine'),
      },
    },
    newShells: first ? { programDir: expandEnv(first[0]), scope: first[1] } : null,
    current: whichSoffice(),
  };
}

/** Which PATH-related flags apply to one install, given a status snapshot. */
export function pathFlagsFor(install, status) {
  const dir = install.programDir;
  const has = (scope) => status.scopes[scope].entries.some((e) => samePath(e.entry, dir));
  const cur = status.current;
  return {
    user: has('user'),
    machine: has('machine'),
    newShells: Boolean(status.newShells && samePath(status.newShells.programDir, dir)),
    current: Boolean(cur && (samePath(cur.dir, dir) || isInside(cur.realPath, install.root))),
  };
}

function shadowWarnings(status, scope, dir) {
  const warnings = [];
  if (status.newShells && !samePath(status.newShells.programDir, dir)) {
    warnings.push(
      `${status.newShells.programDir} (${status.newShells.scope} PATH) still comes first in new shells. ` +
        (isWindows && status.newShells.scope === 'machine'
          ? 'Windows puts the machine PATH before the user PATH: remove it with "lovs path remove --scope machine" or add this version with "--scope machine".'
          : 'Remove it to make this version active.'),
    );
  }
  return warnings;
}

/**
 * Add an install's program folder to the persistent PATH (first position).
 * By default other LibreOffice folders in the same scope are removed.
 */
export async function addToPath(install, { scope = 'user', replace = true } = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of: ${SCOPES.join(', ')}`);
  const s = await readScopes();
  const { entries, removed } = withEntryAdded(s[scope], install.programDir, { replaceLibreOffice: replace });
  const hooks = await writeScope(scope, entries, s.admin);
  const status = await getPathStatus();
  return { scope, added: install.programDir, removed, hooks, warnings: shadowWarnings(status, scope, install.programDir), status };
}

/** Remove one install's folder, or every LibreOffice folder, from a scope. */
export async function removeFromPath({ scope = 'user', install = null } = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of: ${SCOPES.join(', ')}`);
  const s = await readScopes();
  // Every entry in lovs' own Linux file is LibreOffice-related (even if the
  // folder has since been deleted); on Windows we must recognise them.
  const predicate = install ? (e) => samePath(e, install.programDir) : isWindows ? isLoEntry : () => true;
  const { entries, removed } = withEntriesRemoved(s[scope], predicate);
  if (removed.length) await writeScope(scope, entries, s.admin);
  return { scope, removed, status: await getPathStatus() };
}
