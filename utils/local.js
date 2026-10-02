import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './config.js';
import { isWindows, sofficeName } from './platform.js';
import { compareVersions, isVersionString, matchesSpec, numericParts } from './versions.js';

export const METADATA_FILE = '.lovs.json';

const MARKER_FILES = ['bootstrap.ini', 'bootstraprc', 'fundamental.ini', 'fundamentalrc', 'version.ini', 'versionrc'];

// Folders that never contain an install root; skipping them keeps scans fast.
const SKIP_DIRS = new Set(
  [
    'node_modules', 'data', 'share', 'help', 'readmes', 'presets', 'fonts', 'manual', 'java',
    'defaultdata', 'other', 'windows', '$recycle.bin', 'system volume information', 'sdk',
  ],
);

const MAX_DEPTH = 6;

/** A LibreOffice "program" folder: holds soffice plus one of its ini/rc files. */
export function isProgramDir(dir) {
  try {
    if (!fs.statSync(path.join(dir, sofficeName)).isFile()) return false;
  } catch {
    return false;
  }
  return MARKER_FILES.some((f) => fs.existsSync(path.join(dir, f)));
}

export function normalizePath(p) {
  let out = path.resolve(p).replace(/[\\/]+$/, '');
  if (isWindows) out = out.toLowerCase();
  return out;
}

export function isInside(child, parent) {
  if (!parent) return false;
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c === p || c.startsWith(p + path.sep);
}

/** Path with every symlink/junction resolved, or null when it doesn't exist. */
export function realPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** Ownership marker written by lovs after a successful install. */
export function readMetadata(root) {
  const meta = readJson(path.join(root, METADATA_FILE));
  return meta && typeof meta.method === 'string' && typeof meta.version === 'string' ? meta : null;
}

/** UserInstallation from program/bootstrap.ini (Windows) or bootstraprc (Linux). */
export function readUserInstallation(programDir) {
  for (const f of ['bootstrap.ini', 'bootstraprc']) {
    const file = path.join(programDir, f);
    if (fs.existsSync(file)) return readIni(file).UserInstallation ?? null;
  }
  return null;
}

/**
 * True when the profile lives next to the install ($ORIGIN-relative) rather
 * than in the shared %APPDATA% / ~/.config location.
 */
export function hasIsolatedProfile(programDir) {
  return /^\$ORIGIN(\/|$)/.test(readUserInstallation(programDir) ?? '');
}

/**
 * The folder lovs created for this install (its real path, links resolved),
 * or null when lovs doesn't own it. Owned means: lovs metadata at `root`,
 * and the install's top folder (the portable folder, or `root` itself) is
 * really a direct child of the install folder with `root` inside it. This
 * is the only folder uninstall/reinstall will ever delete.
 */
export function ownedInstallDir(root, installDir) {
  if (!installDir || !readMetadata(root)) return null;
  const realTop = realPath(portableRootOf(root) ?? root);
  const realInstallDir = realPath(installDir);
  const realRoot = realPath(root);
  if (!realTop || !realInstallDir || !realRoot) return null;
  if (normalizePath(path.dirname(realTop)) !== normalizePath(realInstallDir)) return null;
  return isInside(realRoot, realTop) ? realTop : null;
}

export function isOwnedInstall(root, installDir) {
  return ownedInstallDir(root, installDir) !== null;
}

function findInstallRoots(dir, depth, out) {
  if (isProgramDir(path.join(dir, 'program'))) {
    out.push(dir);
    return;
  }
  if (depth <= 0) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) findInstallRoots(full, depth - 1, out);
  }
}

/** Install roots (folders that contain program/soffice) below `dir`. */
export function findInstallRootsIn(dir, depth = MAX_DEPTH) {
  const out = [];
  findInstallRoots(dir, depth, out);
  return out;
}

export function readIni(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([^=;#[\s][^=]*?)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in out)) out[m[1]] = m[2];
    }
  } catch {
    // unreadable -> empty
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Portable builds keep LibreOffice in <portable>/App/libreoffice. */
function portableRootOf(root) {
  const parts = path.resolve(root).split(path.sep);
  const n = parts.length;
  if (n >= 3 && parts[n - 1].toLowerCase() === 'libreoffice' && parts[n - 2].toLowerCase() === 'app') {
    return parts.slice(0, n - 2).join(path.sep);
  }
  return null;
}

/** Version from folder names such as "LibreOffice_25.2.7.2" or "/opt/libreoffice25.2". */
export function versionFromPath(p) {
  const parts = path.resolve(p).split(path.sep).reverse().slice(0, 4);
  for (const part of parts) {
    const m = part.match(/(\d+\.\d+(?:\.\d+){0,2})/);
    if (m && isVersionString(m[1])) return m[1];
  }
  return null;
}

// --- `soffice --version` probing (Linux installs carry no version file) ---

const probeCacheFile = () => path.join(cacheDir(), 'probed-versions.json');

function probeVersion(soffice) {
  // soffice.exe is a GUI program on Windows; soffice.com prints to the console.
  const exe = isWindows ? soffice.replace(/\.exe$/i, '.com') : soffice;
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { timeout: 20000, windowsHide: true }, (err, stdout) => {
      const m = String(stdout || '').match(/LibreOffice(?:Dev)?\s+(\d+\.\d+\.\d+\.\d+)/);
      resolve(m ? m[1] : null);
    });
  });
}

async function probeVersions(installs) {
  const cache = readJson(probeCacheFile()) ?? {};
  let changed = false;
  await Promise.all(
    installs.map(async (inst) => {
      let mtime;
      try {
        mtime = fs.statSync(inst.soffice).mtimeMs;
      } catch {
        return;
      }
      const key = normalizePath(inst.root);
      let version = cache[key]?.mtime === mtime ? cache[key].version : undefined;
      if (version === undefined) {
        version = await probeVersion(inst.soffice);
        cache[key] = { mtime, version };
        changed = true;
      }
      if (version) {
        inst.version = version;
        inst.versionSource = 'soffice --version';
      }
    }),
  );
  if (changed) {
    try {
      fs.mkdirSync(cacheDir(), { recursive: true });
      fs.writeFileSync(probeCacheFile(), JSON.stringify(cache));
    } catch {
      // best effort
    }
  }
}

function describeInstall(root, source, installDir) {
  const programDir = path.join(root, 'program');
  const meta = readMetadata(root);
  // Only installs lovs created count as managed; anything else found in the
  // install folder is treated like a scan-folder install (never deleted).
  const owned = isOwnedInstall(root, installDir);
  if (source === 'managed' && !owned) source = 'scanned';
  else if (owned) source = 'managed';
  const portableRoot = portableRootOf(root);
  let version = null;
  let versionSource = null;

  if (meta?.version) {
    version = meta.version;
    versionSource = 'metadata';
  }
  if (!version) {
    for (const f of ['version.ini', 'versionrc']) {
      const v = readIni(path.join(programDir, f)).MsiProductVersion;
      if (v && isVersionString(v)) {
        version = v;
        versionSource = f;
        break;
      }
    }
  }
  if (!version && portableRoot) {
    const v = readIni(path.join(portableRoot, 'App', 'AppInfo', 'appinfo.ini')).DisplayVersion;
    if (v && isVersionString(v)) {
      version = v;
      versionSource = 'appinfo.ini';
    }
  }

  return {
    id: crypto.createHash('sha1').update(normalizePath(root)).digest('hex').slice(0, 10),
    version,
    versionSource,
    label: path.basename(portableRoot ?? root),
    root,
    programDir,
    soffice: path.join(programDir, sofficeName),
    portableRoot,
    kind: meta?.method ?? (portableRoot ? 'portable' : source === 'system' ? 'system' : 'extracted'),
    source,
    managed: source === 'managed',
    isolatedProfile: hasIsolatedProfile(programDir),
    installedAt: meta?.installedAt ?? null,
  };
}

function systemRoots() {
  if (isWindows) {
    return [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]
      .filter(Boolean)
      .map((d) => ({ dir: path.join(d, 'LibreOffice'), depth: 0 }));
  }
  return [
    { dir: '/opt', depth: 1 },
    { dir: '/usr/lib/libreoffice', depth: 0 },
    { dir: '/usr/lib64/libreoffice', depth: 0 },
    { dir: '/usr/local/lib/libreoffice', depth: 0 },
    { dir: '/snap/libreoffice/current/lib/libreoffice', depth: 0 },
  ];
}

/**
 * Find every LibreOffice install in the install folder, the extra scan
 * folders and the usual system locations. Newest version first.
 */
export async function scanLocalInstalls(config, { probe = true } = {}) {
  const roots = [
    { dir: config.installDir, depth: MAX_DEPTH, source: 'managed' },
    ...config.scanDirs.map((dir) => ({ dir, depth: MAX_DEPTH, source: 'scanned' })),
    ...systemRoots().map((r) => ({ ...r, source: 'system' })),
  ];
  const seen = new Set();
  const installs = [];
  for (const { dir, depth, source } of roots) {
    if (!dir || !fs.existsSync(dir)) continue;
    const found = [];
    findInstallRoots(dir, depth, found);
    for (const root of found) {
      let key;
      try {
        key = normalizePath(fs.realpathSync(root));
      } catch {
        key = normalizePath(root);
      }
      if (seen.has(key)) continue;
      seen.add(key);
      installs.push(describeInstall(root, source, config.installDir));
    }
  }

  // Newer builds don't record the full 4-part version in version.ini, so
  // ask soffice itself (cached per install, so only the first scan is slow).
  const incomplete = installs.filter((i) => !i.version || (i.versionSource !== 'metadata' && numericParts(i.version).length < 4));
  if (probe && incomplete.length) await probeVersions(incomplete);
  for (const inst of installs) {
    if (!inst.version) {
      inst.version = versionFromPath(inst.root);
      if (inst.version) inst.versionSource = 'folder name';
    }
  }

  return installs.sort((a, b) => compareVersions(b.version ?? '0', a.version ?? '0'));
}

/**
 * Describe an install from a path given directly by the user: the install
 * root, its program folder, or a portable folder. Returns null otherwise.
 */
export function installFromPath(p, config) {
  const abs = path.resolve(p);
  let root = null;
  if (isProgramDir(path.join(abs, 'program'))) root = abs;
  else if (isProgramDir(abs)) root = path.dirname(abs);
  else if (isProgramDir(path.join(abs, 'App', 'libreoffice', 'program'))) root = path.join(abs, 'App', 'libreoffice');
  if (!root) return null;
  const inst = describeInstall(root, 'scanned', config?.installDir);
  if (!inst.version) {
    inst.version = versionFromPath(root);
    if (inst.version) inst.versionSource = 'folder name';
  }
  return inst;
}

const SOURCE_RANK = { managed: 0, scanned: 1, system: 2 };

/**
 * Resolve a user spec (id, path, or version prefix like "7.6" / "25.2.7")
 * to one local install. Throws with a helpful message when nothing or too
 * much matches.
 */
export function resolveLocal(installs, spec) {
  if (!spec) throw new Error('Specify a version, id or path');
  const byId = installs.find((i) => i.id === spec);
  if (byId) return byId;

  if (/[\\/]/.test(spec) || fs.existsSync(spec)) {
    const target = normalizePath(spec);
    const byPath = installs.find((i) =>
      [i.root, i.programDir, i.portableRoot].filter(Boolean).some((p) => normalizePath(p) === target),
    );
    if (byPath) return byPath;
  }

  const exact = installs.filter((i) => i.version === spec);
  const matches = exact.length ? exact : installs.filter((i) => i.version && matchesSpec(i.version, spec));
  if (!matches.length) {
    const have = installs.map((i) => i.version).filter(Boolean).join(', ') || 'none';
    throw new Error(`No local install matches "${spec}". Installed: ${have}`);
  }
  matches.sort((a, b) => compareVersions(b.version, a.version) || SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
  const best = matches[0];
  const tied = matches.filter((m) => m.version === best.version && m.source === best.source);
  if (tied.length > 1) {
    const list = tied.map((t) => `  ${t.id}  ${t.root}`).join('\n');
    throw new Error(`"${spec}" matches several installs of ${best.version}; use an id or path:\n${list}`);
  }
  return best;
}

/**
 * The argument that makes resolveInstall() pick exactly `inst` again, given
 * the same scan result: its version when that is unambiguous, its id when
 * the scan finds it, otherwise its absolute folder (an install given by path
 * that no scan folder covers). Raw text: quote it for the target shell.
 */
export function selectorFor(inst, installs) {
  if (inst.version) {
    try {
      if (resolveLocal(installs, inst.version).id === inst.id) return inst.version;
    } catch {
      // ambiguous, or the scan doesn't know this install
    }
  }
  if (installs.some((i) => i.id === inst.id)) return inst.id;
  return path.resolve(inst.portableRoot ?? inst.root);
}

/** Scan, then resolve `spec`; falls back to treating `spec` as a folder path. */
export async function resolveInstall(config, spec, installs) {
  installs ??= await scanLocalInstalls(config);
  try {
    return resolveLocal(installs, spec);
  } catch (err) {
    const direct = fs.existsSync(spec) ? installFromPath(spec, config) : null;
    if (direct) return direct;
    throw err;
  }
}
