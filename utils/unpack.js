// Unpack a downloaded package into a staging folder, one function per method.
// Nothing is registered with the OS, so versions coexist freely:
//
//  msi       `msiexec /a` administrative install: files only, no registry, no admin.
//  portable  PortableApps .paf.exe unpacked with 7-Zip; without 7-Zip its
//            installer opens with the destination pre-filled.
//  deb/rpm   official tarball; each package is extracted (not installed), no root.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { isWindows } from './platform.js';
import { findOnPath, runCommand } from './proc.js';

const MSIEXEC_OK = new Set([0, 3010]); // 3010 = success, reboot suggested
const MSIEXEC_ERRORS = {
  112: 'Not enough disk space. Windows Installer also needs free space on the system drive (C:).',
  1602: 'Cancelled by the user.',
  1603: 'Fatal error during installation.',
  1618: 'Another installation is in progress. Wait for it to finish and try again.',
  1619: 'The MSI package could not be opened (corrupt download?).',
};

// `ar` archive layout used by .deb files.
const AR_MAGIC = '!<arch>\n';
const AR_HEADER_SIZE = 60;

/** 7-Zip from the config, the usual install folders, or PATH; null if absent. */
export function findSevenZip(configuredPath) {
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const candidates = [configuredPath, ...programFiles.map((dir) => path.join(dir, '7-Zip', '7z.exe'))].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? findOnPath('7z') ?? findOnPath('7za');
}

/** Fail before downloading anything when the tools a method needs are missing. */
export function assertUnpackTools(method) {
  if (method === 'msi' && !isWindows) throw new Error('The msi method only works on Windows.');
  if (method === 'deb' && !findOnPath('dpkg-deb') && !findOnPath('tar')) {
    throw new Error('"dpkg-deb" or "tar" is required to unpack .deb packages.');
  }
  if (method === 'rpm') {
    for (const tool of ['rpm2cpio', 'cpio']) {
      if (!findOnPath(tool)) {
        throw new Error(`"${tool}" is required to unpack .rpm packages. Install it (e.g. "sudo dnf install ${tool}") or use the deb method.`);
      }
    }
  }
}

async function unpackMsi(msiFile, stagingDir, { signal, onLog }) {
  const logFile = `${stagingDir}-msiexec.log`;
  onLog?.('Running msiexec administrative install (silent, no registry changes)');
  // msiexec parses its own command line, so it gets the line verbatim.
  const commandLine = `/a "${msiFile}" /qn TARGETDIR="${stagingDir}" /L*v "${logFile}"`;
  const { code } = await runCommand('msiexec.exe', [commandLine], { verbatim: true, signal });
  if (!MSIEXEC_OK.has(code)) {
    throw new Error(`msiexec failed with exit code ${code}: ${MSIEXEC_ERRORS[code] ?? 'see log'} (log: ${logFile})`);
  }
  await fsp.rm(logFile, { force: true });
}

async function unpackPortable(installerFile, stagingDir, { sevenZipPath, signal, onLog }) {
  const sevenZip = findSevenZip(sevenZipPath);
  if (sevenZip) {
    onLog?.(`Unpacking portable package with 7-Zip (${sevenZip})`);
    const { code, stderr } = await runCommand(sevenZip, ['x', installerFile, `-o${stagingDir}`, '-y', '-bso0', '-bsp0'], { signal });
    if (code !== 0) throw new Error(`7-Zip failed (exit ${code}): ${stderr.trim()}`);
    await fsp.rm(path.join(stagingDir, '$PLUGINSDIR'), { recursive: true, force: true }); // NSIS internals
    return;
  }
  onLog?.('7-Zip not found: opening the PortableApps installer. Finish its wizard; the destination is pre-filled.');
  await fsp.mkdir(stagingDir, { recursive: true });
  // NSIS reads "/DESTINATION=" up to the next option, spaces included.
  await runCommand(installerFile, [`/DESTINATION=${stagingDir}\\`], { verbatim: true, signal });
}

/** Extract a .deb with dpkg-deb, or — without dpkg (RHEL family) — its data.tar.* via tar. */
async function extractDeb(debFile, destination, signal) {
  if (findOnPath('dpkg-deb')) {
    const { code, stderr } = await runCommand('dpkg-deb', ['-x', debFile, destination], { signal });
    if (code !== 0) throw new Error(`dpkg-deb failed for ${path.basename(debFile)}: ${stderr.trim()}`);
    return;
  }
  const archive = await fsp.readFile(debFile);
  if (archive.toString('ascii', 0, AR_MAGIC.length) !== AR_MAGIC) throw new Error(`${debFile} is not a valid .deb file`);
  for (let offset = AR_MAGIC.length; offset + AR_HEADER_SIZE <= archive.length; ) {
    const memberName = archive.toString('ascii', offset, offset + 16).trim().replace(/\/$/, '');
    const memberSize = parseInt(archive.toString('ascii', offset + 48, offset + 58).trim(), 10);
    const dataStart = offset + AR_HEADER_SIZE;
    if (memberName.startsWith('data.tar')) {
      const dataFile = path.join(destination, `.${path.basename(debFile)}.${memberName}`);
      await fsp.writeFile(dataFile, archive.subarray(dataStart, dataStart + memberSize));
      try {
        const { code, stderr } = await runCommand('tar', ['-xf', dataFile, '-C', destination], { signal });
        if (code !== 0) throw new Error(`tar failed for ${path.basename(debFile)}: ${stderr.trim()}`);
      } finally {
        await fsp.rm(dataFile, { force: true });
      }
      return;
    }
    offset = dataStart + memberSize + (memberSize % 2); // members are 2-byte aligned
  }
  throw new Error(`No data archive found in ${debFile}`);
}

async function extractRpm(rpmFile, destination, signal) {
  const { code, stderr } = await runCommand('sh', ['-c', 'rpm2cpio "$0" | cpio -idmu --quiet', rpmFile], { cwd: destination, signal });
  if (code !== 0) throw new Error(`Unpacking ${path.basename(rpmFile)} failed: ${stderr.trim()}`);
}

/** Package files below `dir`, skipping desktop-integration (it only adds menu entries to /usr). */
function findPackages(dir, extension, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'desktop-integration') findPackages(fullPath, extension, found);
    else if (entry.isFile() && entry.name.endsWith(extension)) found.push(fullPath);
  }
  return found;
}

async function unpackLinuxTarball(tarball, stagingDir, method, { signal, onLog }) {
  const tarballDir = path.join(stagingDir, 'tarball');
  const rootDir = path.join(stagingDir, 'root');
  await fsp.mkdir(tarballDir, { recursive: true });
  await fsp.mkdir(rootDir, { recursive: true });

  onLog?.('Unpacking tarball');
  await tar.x({ file: tarball, cwd: tarballDir });
  const packages = findPackages(tarballDir, `.${method}`);
  if (!packages.length) throw new Error(`No .${method} packages found in ${path.basename(tarball)}`);

  onLog?.(`Unpacking ${packages.length} .${method} packages (no root needed)`);
  for (const packageFile of packages) {
    signal?.throwIfAborted();
    if (method === 'deb') await extractDeb(packageFile, rootDir, signal);
    else await extractRpm(packageFile, rootDir, signal);
  }
  await fsp.rm(tarballDir, { recursive: true, force: true });
}

/** Unpack `packageFile` for `method` into `stagingDir`. */
export async function unpackPackage(method, packageFile, stagingDir, { sevenZipPath, signal, onLog } = {}) {
  if (method === 'msi') return unpackMsi(packageFile, stagingDir, { signal, onLog });
  if (method === 'portable') return unpackPortable(packageFile, stagingDir, { sevenZipPath, signal, onLog });
  return unpackLinuxTarball(packageFile, stagingDir, method, { signal, onLog });
}
