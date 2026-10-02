// Download + install one LibreOffice version side by side with others.
//
//  msi       Windows. `msiexec /a` (administrative install) only unpacks files
//            into a folder: no registry entries, no uninstaller, no admin.
//  portable  Windows. The PortableApps .paf.exe, unpacked silently with 7-Zip,
//            or (without 7-Zip) its installer opened with the folder pre-filled.
//  deb/rpm   Linux. Packages from the official tarball are unpacked (not
//            installed) so no root is needed; the result lives in one folder.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { hashFile, downloadFile, probe } from './download.js';
import { METADATA_FILE, findInstallRootsIn, installFromPath, isInside } from './local.js';
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

/** Point the profile at <install>/user-profile instead of the shared one. */
export function isolateProfile(root) {
  const file = path.join(root, 'program', isWindows ? 'bootstrap.ini' : 'bootstraprc');
  const text = fs.readFileSync(file, 'utf8');
  const line = 'UserInstallation=$ORIGIN/../user-profile';
  const next = /^UserInstallation=.*$/m.test(text)
    ? text.replace(/^UserInstallation=.*$/m, line)
    : text.replace(/^\[Bootstrap\]\s*$/m, (m) => `${m}\n${line}`);
  fs.writeFileSync(file, next);
}

// ------------------------------------------------------------- public API

/**
 * Install `version` with `method` (default per platform/config).
 * Callbacks: onPhase(phase, detail), onProgress({downloaded,total,speed}), onLog(msg).
 */
export async function installVersion({ version, method, config, downloader, force = false, signal, onPhase, onProgress, onLog }) {
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
  if (fs.existsSync(targetDir)) {
    if (!force) throw new Error(`${version} (${method}) is already installed at ${targetDir}. Use --force to reinstall.`);
    onLog?.(`Removing existing ${targetDir}`);
    await fsp.rm(targetDir, { recursive: true, force: true });
  }

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

  onPhase?.('extract', `Installing (${method})`);
  const stage = path.join(config.installDir, `.staging-${version}-${Date.now()}`);
  try {
    if (method === 'msi') await installMsi(file, stage, { signal, onLog });
    else if (method === 'portable') await installPortable(file, stage, { config, signal, onLog });
    else await installLinux(file, stage, method, { signal, onLog });

    const [root] = findInstallRootsIn(stage);
    if (!root) throw new Error('Installation finished but no program/soffice was found in the result');
    // Portable builds are moved as a whole (launchers + App + Data).
    const moveFrom = method === 'portable' ? path.resolve(root, '..', '..') : root;
    await moveDir(moveFrom, targetDir);
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }

  onPhase?.('configure', 'Configuring');
  const installRoot = method === 'portable' ? path.join(targetDir, 'App', 'libreoffice') : targetDir;
  const isolated = method === 'portable' || config.isolateProfile;
  if (method !== 'portable' && config.isolateProfile) isolateProfile(installRoot);
  fs.writeFileSync(
    path.join(installRoot, METADATA_FILE),
    JSON.stringify(
      { version, method, fileName: art.fileName, url: art.url, sha256, downloader: via, isolatedProfile: isolated, installedAt: new Date().toISOString() },
      null,
      2,
    ),
  );

  if (!config.keepDownloads) {
    await fsp.rm(downloadedDir ?? file, { recursive: true, force: true }).catch(() => {});
  }
  onPhase?.('done', `Installed ${version} to ${targetDir}`);
  return installFromPath(installRoot, config);
}

/**
 * Delete a version that lovs installed, removing it from the user PATH first.
 * Installs found via scan folders or system locations are never deleted.
 */
export async function uninstallInstall(install, config) {
  if (!install.managed || !isInside(install.root, config.installDir)) {
    throw new Error(`Only versions inside the install folder (${config.installDir}) can be uninstalled. ${install.root} was left untouched.`);
  }
  const dir = install.portableRoot ?? install.root;
  if (path.resolve(dir) === path.resolve(config.installDir)) throw new Error('Refusing to delete the install folder itself');

  const warnings = [];
  try {
    const flags = pathFlagsFor(install, await getPathStatus());
    if (flags.user) await removeFromPath({ scope: 'user', install });
    if (flags.machine) warnings.push('It is still listed in the machine PATH; remove it with "lovs path remove --scope machine".');
  } catch (err) {
    warnings.push(`Could not update PATH: ${err.message}`);
  }
  await fsp.rm(dir, { recursive: true, force: true });
  return { removed: dir, warnings };
}
