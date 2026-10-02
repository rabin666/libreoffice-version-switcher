// Install and uninstall LibreOffice versions side by side.
//
// install:   lock -> resolve package -> download + verify -> unpack into a
//            staging folder -> configure profile + metadata -> commit (atomic
//            swap with rollback) -> unlock
// uninstall: ownership check -> lock -> re-check -> remove from user PATH -> delete

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { downloadFile, hashFile, probeUrl } from './download.js';
import { assertFreeSpace, moveDir } from './fsutil.js';
import { findInstallRootsIn, installFromPath } from './local.js';
import { acquireInstallLock } from './lock.js';
import { METADATA_FILE, notOwnedError, ownedInstallDir } from './ownership.js';
import { getPathStatus, pathFlagsFor, removeFromPath } from './pathenv.js';
import { detectPlatform, installMethods } from './platform.js';
import { PROFILE_LAYOUTS, hasIsolatedProfile, isolateProfile, setUserInstallation } from './profile.js';
import { fetchSha256, getVersionArtifacts } from './remote.js';
import { assertUnpackTools, unpackPackage } from './unpack.js';
import { downloadWithXdm, findXdm, isXdmRunning } from './xdm.js';

// Unpacked size relative to the download, used for the free-space check.
const UNPACK_SPACE_FACTOR = { msi: 3, other: 4.5 };

export function defaultMethod(config, platform = detectPlatform()) {
  if (platform.os === 'windows') return config.windowsMethod;
  if (platform.os === 'linux' && config.linuxMethod !== 'auto') return config.linuxMethod;
  return installMethods(platform)[0];
}

/** Folder name of a version inside installDir, e.g. "LibreOffice_25.2.7.2_portable". */
export function installFolderName(version, method) {
  return `LibreOffice_${version}${method === 'portable' ? '_portable' : ''}`;
}

/** The LibreOffice root inside an install folder (portable builds nest it in App/libreoffice). */
function libreOfficeRoot(installFolder, method) {
  return method === 'portable' ? path.join(installFolder, 'App', 'libreoffice') : installFolder;
}

/** 'xdm' or 'builtin', from an explicit choice or the config ('auto' = XDM when available). */
export async function resolveDownloader(config, override) {
  const choice = override || config.downloader;
  if (choice === 'builtin') return 'builtin';
  const xdmAvailable = Boolean(findXdm(config.xdmPath)) || (await isXdmRunning());
  if (choice === 'xdm' && !xdmAvailable) {
    throw new Error('XDM was selected but not found. Set "xdmPath" in the config or choose the built-in downloader.');
  }
  return xdmAvailable ? 'xdm' : 'builtin';
}

/**
 * Move `stagedDir` to `targetDir`. An existing install there is first moved
 * aside, then deleted only after the new one is in place, with its `keep`
 * folders (the profile) carried over. Any failure restores the old install.
 * `assertReplaceable` runs right before replacing, since the target may have
 * appeared or changed while the download was running.
 */
export async function commitInstall(stagedDir, targetDir, { keep = [], signal, onLog, assertReplaceable } = {}) {
  signal?.throwIfAborted();
  if (!fs.existsSync(targetDir)) {
    await moveDir(stagedDir, targetDir);
    return { replaced: false };
  }
  if (!assertReplaceable) throw new Error(`${targetDir} already exists`);
  assertReplaceable();

  // Dot prefix: scans skip it, so the old copy is never listed as an install.
  const backupDir = path.join(path.dirname(targetDir), `.lovs-old-${path.basename(targetDir)}-${Date.now()}`);
  try {
    await moveDir(targetDir, backupDir);
  } catch (err) {
    throw new Error(`Could not replace ${targetDir} (is this LibreOffice version still running?): ${err.message}`);
  }

  const carriedOver = [];
  try {
    await moveDir(stagedDir, targetDir);
    for (const relativeDir of keep) {
      const source = path.join(backupDir, relativeDir);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(targetDir, relativeDir);
      await fsp.rm(destination, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await moveDir(source, destination);
      carriedOver.push(relativeDir);
    }
  } catch (err) {
    await restoreBackup({ backupDir, targetDir, carriedOver, onLog }).catch((restoreErr) => {
      err.message += ` (restoring the previous install failed; it is at ${backupDir}: ${restoreErr.message})`;
    });
    throw err;
  }

  if (carriedOver.length) onLog?.(`Kept the existing profile (${carriedOver.join(', ')})`);
  await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => onLog?.(`Could not delete ${backupDir}; remove it manually`));
  return { replaced: true };
}

async function restoreBackup({ backupDir, targetDir, carriedOver, onLog }) {
  for (const relativeDir of carriedOver) await moveDir(path.join(targetDir, relativeDir), path.join(backupDir, relativeDir));
  await fsp.rm(targetDir, { recursive: true, force: true });
  await moveDir(backupDir, targetDir);
  onLog?.('Reinstall failed; the previous installation was restored');
}

/**
 * Install `version` with `method` (default: per platform/config) and resolve
 * with the new install. The target folder is locked for the whole run.
 * Callbacks: onPhase(phase, detail), onProgress({downloaded, total, speed}), onLog(message).
 */
export async function installVersion(options) {
  const method = options.method || defaultMethod(options.config);
  const release = await acquireInstallLock(options.config.installDir, installFolderName(options.version, method));
  try {
    return await installWhileLocked({ ...options, method });
  } finally {
    release();
  }
}

async function installWhileLocked({ version, method, config, downloader, force = false, signal, onPhase, onProgress, onLog }) {
  const platform = detectPlatform();
  if (!platform.supported) throw new Error(`Installing is not supported on ${platform.pretty} (${platform.arch})`);

  onPhase?.('resolve', `Looking up ${version}`);
  assertUnpackTools(method);
  const artifact = await findPackage(version, method, platform, signal);

  const targetDir = path.join(config.installDir, installFolderName(version, method));
  const assertReplaceable = () => {
    if (!force) throw new Error(`${version} (${method}) is already installed at ${targetDir}. Use --force to reinstall.`);
    const existingRoot = libreOfficeRoot(targetDir, method);
    if (!ownedInstallDir(existingRoot, config.installDir)) throw notOwnedError('Not replacing', targetDir, existingRoot, config.installDir);
  };
  if (fs.existsSync(targetDir)) assertReplaceable(); // fail early; re-checked at commit

  await fsp.mkdir(config.installDir, { recursive: true });
  await fsp.mkdir(config.downloadDir, { recursive: true });
  const [sha256, remote] = await Promise.all([fetchSha256(artifact, signal), probeUrl(artifact.url, signal)]);
  const downloadBytes = remote.size ?? artifact.size ?? 0;
  assertFreeSpace(config.downloadDir, downloadBytes * 1.1, 'the download');
  assertFreeSpace(config.installDir, downloadBytes * (UNPACK_SPACE_FACTOR[method] ?? UNPACK_SPACE_FACTOR.other), 'the installation');

  const downloaderName = await resolveDownloader(config, downloader);
  const download = await downloadPackage({ artifact, sha256, expectedSize: remote.size, downloaderName, version, method, config, signal, onPhase, onProgress, onLog });
  signal?.throwIfAborted();

  onPhase?.('extract', `Installing (${method})`);
  const stagingDir = path.join(config.installDir, `.staging-${version}-${Date.now()}`);
  try {
    await unpackPackage(method, download.file, stagingDir, { sevenZipPath: config.sevenZipPath, signal, onLog });
    signal?.throwIfAborted();
    const [stagedRoot] = findInstallRootsIn(stagingDir);
    if (!stagedRoot) throw new Error('Installation finished but no program/soffice was found in the result');

    // Configure while still staged, so the committed install is already complete.
    onPhase?.('configure', 'Configuring');
    const isolatedProfile = configureProfile(stagedRoot, method, config);
    writeMetadata(stagedRoot, { version, method, artifact, sha256, downloaderName, isolatedProfile });

    // Portable builds move as a whole (launchers + App + Data).
    const stagedTop = method === 'portable' ? path.resolve(stagedRoot, '..', '..') : stagedRoot;
    const layout = PROFILE_LAYOUTS[method === 'portable' ? 'portable' : 'standard'];
    await commitInstall(stagedTop, targetDir, { keep: layout.keep, signal, onLog, assertReplaceable });
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  if (!config.keepDownloads) await fsp.rm(download.cleanupPath, { recursive: true, force: true }).catch(() => {});
  onPhase?.('done', `Installed ${version} to ${targetDir}`);
  return installFromPath(libreOfficeRoot(targetDir, method), config);
}

async function findPackage(version, method, platform, signal) {
  const { artifacts } = await getVersionArtifacts(version, { signal });
  const artifact = artifacts.find((candidate) => candidate.method === method);
  if (artifact) return artifact;
  const available = artifacts.map((candidate) => candidate.method).join(', ') || 'none';
  throw new Error(`No ${method} package of ${version} for ${platform.os}/${platform.archDir}. Available: ${available}`);
}

/** Download with XDM or the built-in downloader; resolves with {file, cleanupPath}. */
async function downloadPackage({ artifact, sha256, expectedSize, downloaderName, version, method, config, signal, onPhase, onProgress, onLog }) {
  const how = downloaderName === 'xdm' ? 'XDM' : `${config.connections} connections`;
  onPhase?.('download', `Downloading ${artifact.fileName} (${how})`);

  let download;
  if (downloaderName === 'xdm') {
    const destDir = path.join(config.downloadDir, `xdm-${version}-${method}`);
    const file = await downloadWithXdm({
      url: artifact.url,
      destDir,
      fileName: artifact.fileName,
      expectedSize,
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
    download = { file, cleanupPath: destDir };
  } else {
    const result = await downloadFile({
      url: artifact.url,
      dest: path.join(config.downloadDir, artifact.fileName),
      connections: config.connections,
      sha256,
      signal,
      onProgress,
    });
    if (result.reused) onLog?.('Re-using previously downloaded file');
    download = { file: result.dest, cleanupPath: result.dest };
  }
  if (!sha256) onLog?.('No published SHA-256 found; checked size only');
  return download;
}

/** Give the staged install its own profile where required; returns whether it has one. */
function configureProfile(stagedRoot, method, config) {
  if (method === 'portable') {
    // PATH and `lovs exec` run the inner soffice directly, bypassing the
    // PortableApps launcher that would otherwise set this.
    setUserInstallation(stagedRoot, PROFILE_LAYOUTS.portable.userInstallation);
  } else if (config.isolateProfile) {
    isolateProfile(stagedRoot);
  }
  const isolated = hasIsolatedProfile(path.join(stagedRoot, 'program'));
  if ((method === 'portable' || config.isolateProfile) && !isolated) {
    throw new Error('Could not configure a separate user profile for this install');
  }
  return isolated;
}

/** The ownership marker; without it lovs never replaces or deletes the folder. */
function writeMetadata(root, { version, method, artifact, sha256, downloaderName, isolatedProfile }) {
  const metadata = {
    version,
    method,
    fileName: artifact.fileName,
    url: artifact.url,
    sha256,
    downloader: downloaderName,
    isolatedProfile,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(root, METADATA_FILE), JSON.stringify(metadata, null, 2));
}

/**
 * Delete an install lovs created, removing it from the user PATH first.
 * Holds the same lock as install, and re-checks ownership under it.
 */
export async function uninstall(install, config) {
  const displayDir = install.portableRoot ?? install.root;
  const ownedDir = ownedInstallDir(install.root, config.installDir);
  if (!ownedDir) throw notOwnedError('Not uninstalling', displayDir, install.root, config.installDir);

  const release = await acquireInstallLock(config.installDir, path.basename(ownedDir));
  try {
    if (ownedInstallDir(install.root, config.installDir) !== ownedDir) {
      throw notOwnedError('Not uninstalling', displayDir, install.root, config.installDir);
    }
    const warnings = await removeFromUserPath(install);
    await fsp.rm(ownedDir, { recursive: true, force: true });
    return { removed: ownedDir, warnings };
  } finally {
    release();
  }
}

async function removeFromUserPath(install) {
  const warnings = [];
  try {
    const flags = pathFlagsFor(install, await getPathStatus());
    if (flags.user) await removeFromPath({ scope: 'user', install });
    if (flags.machine) warnings.push('It is still listed in the machine PATH; remove it with "lovs path remove --scope machine".');
  } catch (err) {
    warnings.push(`Could not update PATH: ${err.message}`);
  }
  return warnings;
}
