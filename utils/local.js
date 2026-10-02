// LibreOffice installs on this machine: finding them, describing them, and
// resolving what a user typed ("7.6", an id, a folder) to exactly one.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './config.js';
import { normalizePath, readIni, readJson, writeJsonQuietly } from './fsutil.js';
import { isOwnedInstall, portableRootOf, readMetadata } from './ownership.js';
import { isWindows, sofficeName } from './platform.js';
import { hasIsolatedProfile } from './profile.js';
import { compareVersions, isVersionString, matchesSpec, numericParts } from './versions.js';

const SCAN_DEPTH = 6;
const PROGRAM_DIR_MARKERS = ['bootstrap.ini', 'bootstraprc', 'fundamental.ini', 'fundamentalrc', 'version.ini', 'versionrc'];
// Folders that never contain an install root; skipping them keeps scans fast.
const SKIPPED_DIRS = new Set([
  'node_modules', 'data', 'share', 'help', 'readmes', 'presets', 'fonts', 'manual', 'java',
  'defaultdata', 'other', 'windows', '$recycle.bin', 'system volume information', 'sdk',
]);
// When several installs match a version, prefer lovs-managed ones.
const SOURCE_PRIORITY = { managed: 0, scanned: 1, system: 2 };

/** A LibreOffice "program" folder: soffice plus one of its ini/rc files. */
export function isProgramDir(dir) {
  try {
    if (!fs.statSync(path.join(dir, sofficeName)).isFile()) return false;
  } catch {
    return false;
  }
  return PROGRAM_DIR_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)));
}

function isDirectory(entry, fullPath) {
  if (!entry.isSymbolicLink()) return entry.isDirectory();
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

/** Install roots (folders containing program/soffice) up to `depth` levels below `dir`. */
export function findInstallRootsIn(dir, depth = SCAN_DEPTH, found = []) {
  if (isProgramDir(path.join(dir, 'program'))) {
    found.push(dir);
    return found;
  }
  if (depth <= 0) return found;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    // Dot folders include lovs' own staging, backup and lock files.
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name.toLowerCase())) continue;
    const fullPath = path.join(dir, entry.name);
    if (isDirectory(entry, fullPath)) findInstallRootsIn(fullPath, depth - 1, found);
  }
  return found;
}

/** Version from folder names such as "LibreOffice_25.2.7.2" or "/opt/libreoffice25.2". */
export function versionFromPath(target) {
  const nearestFolders = path.resolve(target).split(path.sep).reverse().slice(0, 4);
  for (const folder of nearestFolders) {
    const match = folder.match(/(\d+\.\d+(?:\.\d+){0,2})/);
    if (match && isVersionString(match[1])) return match[1];
  }
  return null;
}

/** {version, source} from lovs metadata, version.ini/versionrc, or the portable appinfo.ini. */
function readRecordedVersion(programDir, metadata, portableRoot) {
  if (metadata?.version) return { version: metadata.version, source: 'metadata' };
  for (const file of ['version.ini', 'versionrc']) {
    const version = readIni(path.join(programDir, file)).MsiProductVersion;
    if (version && isVersionString(version)) return { version, source: file };
  }
  if (portableRoot) {
    const version = readIni(path.join(portableRoot, 'App', 'AppInfo', 'appinfo.ini')).DisplayVersion;
    if (version && isVersionString(version)) return { version, source: 'appinfo.ini' };
  }
  return { version: null, source: null };
}

function kindOf(metadata, portableRoot, source) {
  if (metadata?.method) return metadata.method;
  if (portableRoot) return 'portable';
  return source === 'system' ? 'system' : 'extracted';
}

/**
 * Everything the CLI and UI show about one install. `source` is where it was
 * found; it becomes 'managed' only when lovs really owns it.
 */
function describeInstall(root, source, installDir) {
  const programDir = path.join(root, 'program');
  const metadata = readMetadata(root);
  const portableRoot = portableRootOf(root);
  const owned = isOwnedInstall(root, installDir);
  const effectiveSource = owned ? 'managed' : source === 'managed' ? 'scanned' : source;
  const recorded = readRecordedVersion(programDir, metadata, portableRoot);

  return {
    id: crypto.createHash('sha1').update(normalizePath(root)).digest('hex').slice(0, 10),
    version: recorded.version,
    versionSource: recorded.source,
    label: path.basename(portableRoot ?? root),
    root,
    programDir,
    soffice: path.join(programDir, sofficeName),
    portableRoot,
    kind: kindOf(metadata, portableRoot, effectiveSource),
    source: effectiveSource,
    managed: owned,
    isolatedProfile: hasIsolatedProfile(programDir),
    installedAt: metadata?.installedAt ?? null,
  };
}

function fillVersionFromPath(install) {
  if (install.version) return;
  install.version = versionFromPath(install.root);
  if (install.version) install.versionSource = 'folder name';
}

// --- `soffice --version` probing: newer builds record only 3 version parts ---

const probeCacheFile = () => path.join(cacheDir(), 'probed-versions.json');

function probeVersion(soffice) {
  // soffice.exe is a GUI program on Windows; soffice.com writes to the console.
  const executable = isWindows ? soffice.replace(/\.exe$/i, '.com') : soffice;
  return new Promise((resolve) => {
    execFile(executable, ['--version'], { timeout: 20000, windowsHide: true }, (err, stdout) => {
      const match = String(stdout || '').match(/LibreOffice(?:Dev)?\s+(\d+\.\d+\.\d+\.\d+)/);
      resolve(match ? match[1] : null);
    });
  });
}

/** Fill in full versions by running soffice; cached per install and soffice mtime. */
async function probeVersions(installs) {
  const cache = readJson(probeCacheFile()) ?? {};
  let cacheChanged = false;
  await Promise.all(
    installs.map(async (install) => {
      let modifiedAt;
      try {
        modifiedAt = fs.statSync(install.soffice).mtimeMs;
      } catch {
        return;
      }
      const key = normalizePath(install.root);
      let version = cache[key]?.mtime === modifiedAt ? cache[key].version : undefined;
      if (version === undefined) {
        version = await probeVersion(install.soffice);
        cache[key] = { mtime: modifiedAt, version };
        cacheChanged = true;
      }
      if (version) {
        install.version = version;
        install.versionSource = 'soffice --version';
      }
    }),
  );
  if (cacheChanged) writeJsonQuietly(probeCacheFile(), cache);
}

function needsProbe(install) {
  return !install.version || (install.versionSource !== 'metadata' && numericParts(install.version).length < 4);
}

function systemLocations() {
  if (isWindows) {
    return [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]
      .filter(Boolean)
      .map((programFiles) => ({ dir: path.join(programFiles, 'LibreOffice'), depth: 0 }));
  }
  return [
    { dir: '/opt', depth: 1 },
    { dir: '/usr/lib/libreoffice', depth: 0 },
    { dir: '/usr/lib64/libreoffice', depth: 0 },
    { dir: '/usr/local/lib/libreoffice', depth: 0 },
    { dir: '/snap/libreoffice/current/lib/libreoffice', depth: 0 },
  ];
}

function realKey(root) {
  try {
    return normalizePath(fs.realpathSync(root));
  } catch {
    return normalizePath(root);
  }
}

/**
 * Every install in installDir, the scan folders and the usual system
 * locations, newest first. `probe: false` skips running soffice (faster, but
 * some versions stay 3-part).
 */
export async function scanLocalInstalls(config, { probe = true } = {}) {
  const locations = [
    { dir: config.installDir, depth: SCAN_DEPTH, source: 'managed' },
    ...config.scanDirs.map((dir) => ({ dir, depth: SCAN_DEPTH, source: 'scanned' })),
    ...systemLocations().map((location) => ({ ...location, source: 'system' })),
  ];
  const seenRealPaths = new Set();
  const installs = [];
  for (const { dir, depth, source } of locations) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const root of findInstallRootsIn(dir, depth)) {
      const key = realKey(root);
      if (seenRealPaths.has(key)) continue;
      seenRealPaths.add(key);
      installs.push(describeInstall(root, source, config.installDir));
    }
  }

  const unprobed = installs.filter(needsProbe);
  if (probe && unprobed.length) await probeVersions(unprobed);
  installs.forEach(fillVersionFromPath);
  return installs.sort((a, b) => compareVersions(b.version ?? '0', a.version ?? '0'));
}

/**
 * Describe the install at a path the user gave: the install root, its
 * program folder, or a portable folder. null when it isn't one.
 */
export function installFromPath(target, config) {
  const absolute = path.resolve(target);
  let root = null;
  if (isProgramDir(path.join(absolute, 'program'))) root = absolute;
  else if (isProgramDir(absolute)) root = path.dirname(absolute);
  else if (isProgramDir(path.join(absolute, 'App', 'libreoffice', 'program'))) root = path.join(absolute, 'App', 'libreoffice');
  if (!root) return null;
  const install = describeInstall(root, 'scanned', config?.installDir);
  fillVersionFromPath(install);
  return install;
}

function matchesPath(install, target) {
  return [install.root, install.programDir, install.portableRoot].filter(Boolean).some((candidate) => normalizePath(candidate) === target);
}

/**
 * The one install in `installs` that `spec` (id, path, or version prefix
 * like "7.6") selects. Throws a helpful error when none or several match.
 */
export function matchInstall(installs, spec) {
  if (!spec) throw new Error('Specify a version, id or path');
  const byId = installs.find((install) => install.id === spec);
  if (byId) return byId;

  if (/[\\/]/.test(spec) || fs.existsSync(spec)) {
    const target = normalizePath(spec);
    const byPath = installs.find((install) => matchesPath(install, target));
    if (byPath) return byPath;
  }

  const exact = installs.filter((install) => install.version === spec);
  const candidates = exact.length ? exact : installs.filter((install) => install.version && matchesSpec(install.version, spec));
  if (!candidates.length) {
    const available = installs.map((install) => install.version).filter(Boolean).join(', ') || 'none';
    throw new Error(`No local install matches "${spec}". Installed: ${available}`);
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version) || SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]);
  const best = candidates[0];
  const tied = candidates.filter((candidate) => candidate.version === best.version && candidate.source === best.source);
  if (tied.length > 1) {
    const choices = tied.map((candidate) => `  ${candidate.id}  ${candidate.root}`).join('\n');
    throw new Error(`"${spec}" matches several installs of ${best.version}; use an id or path:\n${choices}`);
  }
  return best;
}

/** Scan (unless `installs` is given) and match `spec`; a folder no scan covers also works. */
export async function resolveInstall(config, spec, installs) {
  installs ??= await scanLocalInstalls(config);
  try {
    return matchInstall(installs, spec);
  } catch (err) {
    const atPath = fs.existsSync(spec) ? installFromPath(spec, config) : null;
    if (atPath) return atPath;
    throw err;
  }
}

/**
 * The argument that makes resolveInstall() select `install` again from the
 * same scan: its version if unambiguous, else its id if scanned, else its
 * absolute folder. Unquoted; quote it for the target shell.
 */
export function selectorFor(install, installs) {
  if (install.version) {
    try {
      if (matchInstall(installs, install.version).id === install.id) return install.version;
    } catch {
      // ambiguous, or not in this scan
    }
  }
  if (installs.some((candidate) => candidate.id === install.id)) return install.id;
  return path.resolve(install.portableRoot ?? install.root);
}
