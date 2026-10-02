// Download + install one LibreOffice version side by side with others.
//
//  msi       Windows. `msiexec /a` (administrative install) only unpacks files
//            into a folder: no registry entries, no uninstaller, no admin.
//  portable  Windows. The PortableApps .paf.exe, unpacked silently with 7-Zip,
//            or (without 7-Zip) its installer opened with the folder pre-filled.
//  deb/rpm   Linux. Packages from the official tarball are unpacked (not
//            installed) so no root is needed; the result lives in one folder.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { hashFile, downloadFile, probe } from './download.js';
import {
  METADATA_FILE,
  findInstallRootsIn,
  hasIsolatedProfile,
  installFromPath,
  ownedInstallDir,
  readMetadata,
  realPath,
} from './local.js';
import { getPathStatus, pathFlagsFor, removeFromPath } from './pathenv.js';
import { detectPlatform, installMethods, isWindows } from './platform.js';
import { findOnPath, run } from './proc.js';
import { fetchSha256, getVersionArtifacts } from './remote.js';
import { downloadWithXdm, findXdm, isXdmRunning } from './xdm.js';

export function defaultMethod(config, platform = detectPlatform()) {
  if (platform.os === 'windows') return config.windowsMethod;
  if (platform.os === 'linux' && config.linuxMethod !== 'auto') return config.linuxMethod;
  return installMethods(platform)[0];
}

export function targetDirName(version, method) {
  return `LibreOffice_${version}${method === 'portable' ? '_portable' : ''}`;
}

export function findSevenZip(configured) {
  const candidates = [
    configured,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, '7-Zip', '7z.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], '7-Zip', '7z.exe'),
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) ?? findOnPath('7z') ?? findOnPath('7za');
}

/** Which downloader will be used: 'xdm' or 'builtin'. */
export async function resolveDownloader(config, override) {
  const choice = override || config.downloader;
  if (choice === 'builtin') return 'builtin';
  const available = Boolean(findXdm(config.xdmPath)) || (await isXdmRunning());
  if (choice === 'xdm' && !available) {
    throw new Error('XDM was selected but not found. Set "xdmPath" in the config or choose the built-in downloader.');
  }
  return available ? 'xdm' : 'builtin';
}

function freeSpace(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

function assertFreeSpace(dir, needed, what) {
  const free = freeSpace(dir);
  if (free !== null && free < needed) {
    const gb = (n) => (n / 1024 ** 3).toFixed(1);
    throw new Error(`Not enough free space for ${what} in ${dir}: need about ${gb(needed)} GB, have ${gb(free)} GB`);
  }
}

async function moveDir(src, dst) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(src, dst);
      return;
    } catch (err) {
      if (err.code === 'EXDEV') {
        await fsp.cp(src, dst, { recursive: true });
        await fsp.rm(src, { recursive: true, force: true });
        return;
      }
      // Windows: antivirus or the indexer may briefly hold files open.
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

// ------------------------------------------------------------- per method

const MSI_ERRORS = {
  112: 'Not enough disk space. Windows Installer also needs free space on the system drive (C:).',
  1602: 'Cancelled by the user.',
  1603: 'Fatal error during installation.',
  1618: 'Another installation is in progress. Wait for it to finish and try again.',
  1619: 'The MSI package could not be opened (corrupt download?).',
};

async function installMsi(msi, stage, { signal, onLog }) {
  const log = `${stage}-msiexec.log`;
  onLog?.('Running msiexec administrative install (silent, no registry changes)');
  // msiexec does its own command-line parsing, so build the line verbatim.
  const args = `/a "${msi}" /qn TARGETDIR="${stage}" /L*v "${log}"`;
  const { code } = await run('msiexec.exe', [args], { verbatim: true, signal });
  if (code !== 0 && code !== 3010) {
    throw new Error(`msiexec failed with exit code ${code}: ${MSI_ERRORS[code] ?? 'see log'} (log: ${log})`);
  }
  await fsp.rm(log, { force: true });
}

async function installPortable(paf, stage, { config, signal, onLog }) {
  const sevenZip = findSevenZip(config.sevenZipPath);
  if (sevenZip) {
    onLog?.(`Unpacking portable package with 7-Zip (${sevenZip})`);
    const { code, stderr } = await run(sevenZip, ['x', paf, `-o${stage}`, '-y', '-bso0', '-bsp0'], { signal });
    if (code !== 0) throw new Error(`7-Zip failed (exit ${code}): ${stderr.trim()}`);
    await fsp.rm(path.join(stage, '$PLUGINSDIR'), { recursive: true, force: true });
    return;
  }
  onLog?.('7-Zip not found: opening the PortableApps installer. Finish its wizard; the destination is pre-filled.');
  await fsp.mkdir(stage, { recursive: true });
  // NSIS reads "/DESTINATION=" up to the next option, spaces included.
  await run(paf, [`/DESTINATION=${stage}\\`], { verbatim: true, signal });
}

async function extractDeb(deb, destRoot, signal) {
  if (findOnPath('dpkg-deb')) {
    const { code, stderr } = await run('dpkg-deb', ['-x', deb, destRoot], { signal });
    if (code !== 0) throw new Error(`dpkg-deb failed for ${path.basename(deb)}: ${stderr.trim()}`);
    return;
  }
  // No dpkg (RHEL family): a .deb is an "ar" archive; pull out data.tar.* and
  // let the system tar decompress it.
  const buf = await fsp.readFile(deb);
  if (buf.toString('ascii', 0, 8) !== '!<arch>\n') throw new Error(`${deb} is not a valid .deb file`);
  for (let off = 8; off + 60 <= buf.length; ) {
    const name = buf.toString('ascii', off, off + 16).trim().replace(/\/$/, '');
    const size = parseInt(buf.toString('ascii', off + 48, off + 58).trim(), 10);
    if (name.startsWith('data.tar')) {
      const tmp = path.join(destRoot, `.${path.basename(deb)}.${name}`);
      await fsp.writeFile(tmp, buf.subarray(off + 60, off + 60 + size));
      try {
        const { code, stderr } = await run('tar', ['-xf', tmp, '-C', destRoot], { signal });
        if (code !== 0) throw new Error(`tar failed for ${path.basename(deb)}: ${stderr.trim()}`);
      } finally {
        await fsp.rm(tmp, { force: true });
      }
      return;
    }
    off += 60 + size + (size % 2);
  }
  throw new Error(`No data archive found in ${deb}`);
}

/** Fail before downloading anything if the unpack tools are missing. */
function assertTools(method) {
  if (method === 'rpm') {
    for (const tool of ['rpm2cpio', 'cpio']) {
      if (!findOnPath(tool)) {
        throw new Error(`"${tool}" is required to unpack .rpm packages. Install it (e.g. "sudo dnf install ${tool}") or use the deb method.`);
      }
    }
  } else if (method === 'deb' && !findOnPath('dpkg-deb') && !findOnPath('tar')) {
    throw new Error('"dpkg-deb" or "tar" is required to unpack .deb packages.');
  } else if (method === 'msi' && !isWindows) {
    throw new Error('The msi method only works on Windows.');
  }
}

async function extractRpm(rpm, destRoot, signal) {
  const { code, stderr } = await run('sh', ['-c', 'rpm2cpio "$0" | cpio -idmu --quiet', rpm], { cwd: destRoot, signal });
  if (code !== 0) throw new Error(`Unpacking ${path.basename(rpm)} failed: ${stderr.trim()}`);
}

function listFiles(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    // desktop-integration packages only add menu entries to /usr; skip them.
    if (e.isDirectory() && e.name !== 'desktop-integration') listFiles(full, ext, out);
    else if (e.isFile() && e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

async function installLinux(tarball, stage, method, { signal, onLog }) {
  const unpacked = path.join(stage, 'tarball');
  const root = path.join(stage, 'root');
  await fsp.mkdir(unpacked, { recursive: true });
  await fsp.mkdir(root, { recursive: true });
  onLog?.('Unpacking tarball');
  await tar.x({ file: tarball, cwd: unpacked });
  const pkgs = listFiles(unpacked, `.${method}`);
  if (!pkgs.length) throw new Error(`No .${method} packages found in ${path.basename(tarball)}`);
  onLog?.(`Unpacking ${pkgs.length} .${method} packages (no root needed)`);
  for (const pkg of pkgs) {
    if (signal?.aborted) throw new Error('Cancelled');
    if (method === 'deb') await extractDeb(pkg, root, signal);
    else await extractRpm(pkg, root, signal);
  }
  await fsp.rm(unpacked, { recursive: true, force: true });
}

// Where each kind of install keeps its profile (UserInstallation, relative
// to the program folder) and which folders to carry over on reinstall
// (relative to the install's top folder).
const PROFILE = {
  standard: { userInstallation: '$ORIGIN/../user-profile', keep: ['user-profile'] },
  // Same location the PortableApps launcher uses: <portable>/Data/settings.
  portable: { userInstallation: '$ORIGIN/../../../Data/settings', keep: ['Data'] },
};

/** Set UserInstallation in program/bootstrap.ini (Windows) or bootstraprc (Linux). */
export function setUserInstallation(root, value) {
  const program = path.join(root, 'program');
  const file = ['bootstrap.ini', 'bootstraprc'].map((f) => path.join(program, f)).find((f) => fs.existsSync(f));
  if (!file) throw new Error(`No bootstrap.ini/bootstraprc in ${program}`);
  const text = fs.readFileSync(file, 'utf8');
  const line = `UserInstallation=${value}`;
  let next;
  if (/^UserInstallation=.*$/m.test(text)) next = text.replace(/^UserInstallation=.*$/m, line);
  else if (/^\[Bootstrap\][ \t]*$/m.test(text)) next = text.replace(/^\[Bootstrap\][ \t]*$/m, (m) => `${m}\n${line}`);
  else next = `[Bootstrap]\n${line}\n${text}`;
  fs.writeFileSync(file, next);
}

/** Point the profile at <install>/user-profile instead of the shared one. */
export function isolateProfile(root) {
  setUserInstallation(root, PROFILE.standard.userInstallation);
}

/**
 * Put `stagedDir` at `targetDir`. An existing install there is moved aside
 * first and only deleted once the new one is in place; its profile folders
 * (`keep`) are carried over. On any failure the old install is restored.
 */
export async function commitInstall(stagedDir, targetDir, { keep = [], signal, onLog, assertReplaceable } = {}) {
  signal?.throwIfAborted();
  if (!fs.existsSync(targetDir)) {
    await moveDir(stagedDir, targetDir);
    return { replaced: false };
  }
  // Re-checked here, not just before downloading: the folder may have
  // appeared (or changed owner) while the download was running.
  if (!assertReplaceable) throw new Error(`${targetDir} already exists`);
  assertReplaceable();

  // Dot-prefixed so scans never list it as another install.
  const backup = path.join(path.dirname(targetDir), `.lovs-old-${path.basename(targetDir)}-${Date.now()}`);
  try {
    await moveDir(targetDir, backup);
  } catch (err) {
    throw new Error(`Could not replace ${targetDir} (is this LibreOffice version still running?): ${err.message}`);
  }
  const carried = [];
  try {
    await moveDir(stagedDir, targetDir);
    for (const rel of keep) {
      const from = path.join(backup, rel);
      if (!fs.existsSync(from)) continue;
      const to = path.join(targetDir, rel);
      await fsp.rm(to, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await moveDir(from, to);
      carried.push(rel);
    }
  } catch (err) {
    try {
      for (const rel of carried) await moveDir(path.join(targetDir, rel), path.join(backup, rel));
      await fsp.rm(targetDir, { recursive: true, force: true });
      await moveDir(backup, targetDir);
      onLog?.('Reinstall failed; the previous installation was restored');
    } catch (rollbackErr) {
      err.message += ` (restoring the previous install failed; it is at ${backup}: ${rollbackErr.message})`;
    }
    throw err;
  }
  if (carried.length) onLog?.(`Kept the existing profile (${carried.join(', ')})`);
  await fsp.rm(backup, { recursive: true, force: true }).catch(() => onLog?.(`Could not delete ${backup}; remove it manually`));
  return { replaced: true };
}

// ------------------------------------------------------------- public API

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A lock (or stale-lock breaker) that holds no readable owner is assumed to
// be still being written, until it is older than this.
const LOCK_GRACE_MS = 30_000;

function readLock(file) {
  let text;
  let mtimeMs;
  try {
    text = fs.readFileSync(file, 'utf8');
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let owner = null;
  try {
    const parsed = JSON.parse(text);
    if (Number.isInteger(parsed?.pid)) owner = parsed;
  } catch {
    // empty or partly written
  }
  return { text, owner, age: Date.now() - mtimeMs };
}

const isAbandoned = (lock) =>
  lock.owner ? lock.owner.pid !== process.pid && !pidAlive(lock.owner.pid) : lock.age > LOCK_GRACE_MS;

/**
 * Create `file` holding `content`, or return false if it already exists.
 * The file appears with its content in one step (hard link of a finished
 * temp file), so no other process can ever see it empty.
 */
function createExclusive(file, content) {
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { flag: 'wx' });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    // No hard links here (FAT/exFAT, some network shares): plain exclusive
    // create. Readers treat the brief empty state as "being written".
    try {
      fs.writeFileSync(file, content, { flag: 'wx' });
      return true;
    } catch (err2) {
      if (err2.code === 'EEXIST') return false;
      throw err2;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Remove `file` only if it still holds `staleText`. Breakers serialize on
 * `<file>.break` and re-read under it, so a lock created after the stale one
 * was observed is never removed.
 */
function breakStaleLock(file, staleText) {
  const breaker = `${file}.break`;
  if (!createExclusive(breaker, JSON.stringify({ pid: process.pid, at: Date.now() }))) {
    const other = readLock(breaker);
    // A breaker holds its lock for microseconds; one that is old or whose
    // process is gone crashed mid-way.
    if (other && (other.age > LOCK_GRACE_MS || (other.owner && !pidAlive(other.owner.pid)))) fs.rmSync(breaker, { force: true });
    return;
  }
  try {
    if (readLock(file)?.text === staleText) fs.rmSync(file, { force: true });
  } finally {
    fs.rmSync(breaker, { force: true });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Exclusive lock on one install folder, shared by every lovs process (CLI
 * and web UI) and by install and uninstall. A lock left by a process that
 * no longer runs is taken over. Returns the release function.
 */
export async function acquireInstallLock(installDir, name) {
  await fsp.mkdir(installDir, { recursive: true });
  const file = path.join(installDir, `.lovs-lock-${name}`);
  const mine = JSON.stringify({ pid: process.pid, token: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString() });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (createExclusive(file, mine)) {
      return () => {
        // Only remove the lock if it is still ours.
        if (readLock(file)?.text === mine) fs.rmSync(file, { force: true });
      };
    }
    const held = readLock(file);
    if (!held) continue; // released in the meantime
    if (!isAbandoned(held)) {
      const who = held.owner?.pid === process.pid ? 'this lovs process' : held.owner ? `another lovs process (pid ${held.owner.pid})` : 'another lovs process';
      throw new Error(`${name} is busy: ${who} is installing or uninstalling it. Wait for it to finish (or delete ${file} if no lovs is running).`);
    }
    breakStaleLock(file, held.text);
    await sleep(20 + Math.random() * 80);
  }
  throw new Error(`Could not lock ${file}`);
}

/**
 * Install `version` with `method` (default per platform/config).
 * Callbacks: onPhase(phase, detail), onProgress({downloaded,total,speed}), onLog(msg).
 *
 * With `force`, an existing install of the same version/method is only
 * replaced after the new one has been downloaded, unpacked and configured.
 * The target is locked for the whole install.
 */
export async function installVersion(opts) {
  const method = opts.method || defaultMethod(opts.config);
  const release = await acquireInstallLock(opts.config.installDir, targetDirName(opts.version, method));
  try {
    return await installUnlocked({ ...opts, method });
  } finally {
    release();
  }
}

async function installUnlocked({ version, method, config, downloader, force = false, signal, onPhase, onProgress, onLog }) {
  const platform = detectPlatform();
  if (!platform.supported) throw new Error(`Installing is not supported on ${platform.pretty} (${platform.arch})`);

  onPhase?.('resolve', `Looking up ${version}`);
  method ||= defaultMethod(config, platform);
  assertTools(method);
  const { artifacts } = await getVersionArtifacts(version, { signal });
  const art = artifacts.find((a) => a.method === method);
  if (!art) {
    const other = artifacts.map((a) => a.method).join(', ') || 'none';
    throw new Error(`No ${method} package of ${version} for ${platform.os}/${platform.archDir}. Available: ${other}`);
  }

  const targetDir = path.join(config.installDir, targetDirName(version, method));
  const assertReplaceable = () => {
    if (!force) throw new Error(`${version} (${method}) is already installed at ${targetDir}. Use --force to reinstall.`);
    // --force only ever replaces a folder lovs created itself.
    const existingRoot = method === 'portable' ? path.join(targetDir, 'App', 'libreoffice') : targetDir;
    if (!ownedInstallDir(existingRoot, config.installDir)) throw notOwnedError(targetDir, existingRoot, config, 'Not replacing');
  };
  if (fs.existsSync(targetDir)) assertReplaceable();

  await fsp.mkdir(config.installDir, { recursive: true });
  await fsp.mkdir(config.downloadDir, { recursive: true });
  const [sha256, head] = await Promise.all([fetchSha256(art, signal), probe(art.url, signal)]);
  const size = head.size ?? art.size ?? 0;
  assertFreeSpace(config.downloadDir, size * 1.1, 'the download');
  assertFreeSpace(config.installDir, size * (method === 'msi' ? 3 : 4.5), 'the installation');

  const via = await resolveDownloader(config, downloader);
  onPhase?.('download', `Downloading ${art.fileName} (${via === 'xdm' ? 'XDM' : `${config.connections} connections`})`);
  let file;
  let downloadedDir = null;
  if (via === 'xdm') {
    downloadedDir = path.join(config.downloadDir, `xdm-${version}-${method}`);
    file = await downloadWithXdm({
      url: art.url,
      destDir: downloadedDir,
      fileName: art.fileName,
      expectedSize: head.size,
      xdmPath: config.xdmPath,
      signal,
      onProgress,
      onLog,
    });
    if (sha256) {
      onPhase?.('verify', 'Verifying SHA-256');
      const actual = await hashFile(file);
      if (actual !== sha256) throw new Error(`SHA-256 mismatch (expected ${sha256}, got ${actual})`);
    }
  } else {
    const res = await downloadFile({
      url: art.url,
      dest: path.join(config.downloadDir, art.fileName),
      connections: config.connections,
      sha256,
      signal,
      onProgress,
    });
    file = res.dest;
    if (res.reused) onLog?.('Re-using previously downloaded file');
  }
  if (!sha256) onLog?.('No published SHA-256 found; checked size only');
  signal?.throwIfAborted();

  onPhase?.('extract', `Installing (${method})`);
  const stage = path.join(config.installDir, `.staging-${version}-${Date.now()}`);
  const portable = method === 'portable';
  try {
    if (method === 'msi') await installMsi(file, stage, { signal, onLog });
    else if (portable) await installPortable(file, stage, { config, signal, onLog });
    else await installLinux(file, stage, method, { signal, onLog });
    signal?.throwIfAborted();

    const [root] = findInstallRootsIn(stage);
    if (!root) throw new Error('Installation finished but no program/soffice was found in the result');

    // Configure inside the staging folder so the committed install is complete.
    onPhase?.('configure', 'Configuring');
    if (portable) {
      // PATH and `lovs exec` run the inner soffice directly, bypassing the
      // PortableApps launcher, so the profile location must be set here.
      setUserInstallation(root, PROFILE.portable.userInstallation);
    } else if (config.isolateProfile) {
      isolateProfile(root);
    }
    const isolated = hasIsolatedProfile(path.join(root, 'program'));
    if ((portable || config.isolateProfile) && !isolated) throw new Error('Could not configure a separate user profile for this install');
    fs.writeFileSync(
      path.join(root, METADATA_FILE),
      JSON.stringify(
        { version, method, fileName: art.fileName, url: art.url, sha256, downloader: via, isolatedProfile: isolated, installedAt: new Date().toISOString() },
        null,
        2,
      ),
    );

    // Portable builds are moved as a whole (launchers + App + Data).
    const moveFrom = portable ? path.resolve(root, '..', '..') : root;
    await commitInstall(moveFrom, targetDir, { keep: PROFILE[portable ? 'portable' : 'standard'].keep, signal, onLog, assertReplaceable });
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }

  if (!config.keepDownloads) {
    await fsp.rm(downloadedDir ?? file, { recursive: true, force: true }).catch(() => {});
  }
  onPhase?.('done', `Installed ${version} to ${targetDir}`);
  return installFromPath(portable ? path.join(targetDir, 'App', 'libreoffice') : targetDir, config);
}

function notOwnedError(dir, root, config, action) {
  const why = !readMetadata(root)
    ? `it was not installed by lovs (no ${METADATA_FILE})`
    : `its real location (${realPath(dir) ?? 'missing'}) is not directly inside the install folder (${realPath(config.installDir) ?? config.installDir})`;
  return new Error(`${action} ${dir}: ${why}. Nothing was deleted.`);
}

/**
 * Delete a version that lovs installed, removing it from the user PATH first.
 * Only folders lovs created are deleted: they must carry lovs metadata and
 * really (links resolved) be a direct child of the install folder.
 */
export async function uninstallInstall(install, config) {
  const dir = install.portableRoot ?? install.root;
  const owned = ownedInstallDir(install.root, config.installDir);
  if (!owned) throw notOwnedError(dir, install.root, config, 'Not uninstalling');

  // Same lock as install: never delete a folder while it is being
  // (re)installed, e.g. between moving the old copy aside and committing.
  const release = await acquireInstallLock(config.installDir, path.basename(owned));
  try {
    // Re-check under the lock: the folder may have been replaced meanwhile.
    const realDir = ownedInstallDir(install.root, config.installDir);
    if (!realDir || realDir !== owned) throw notOwnedError(dir, install.root, config, 'Not uninstalling');

    const warnings = [];
    try {
      const flags = pathFlagsFor(install, await getPathStatus());
      if (flags.user) await removeFromPath({ scope: 'user', install });
      if (flags.machine) warnings.push('It is still listed in the machine PATH; remove it with "lovs path remove --scope machine".');
    } catch (err) {
      warnings.push(`Could not update PATH: ${err.message}`);
    }
    await fsp.rm(realDir, { recursive: true, force: true });
    return { removed: realDir, warnings };
  } finally {
    release();
  }
}
