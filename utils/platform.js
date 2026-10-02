// Describes the current machine in the terms the LibreOffice archive uses.

import fs from 'node:fs';
import os from 'node:os';

export const isWindows = process.platform === 'win32';

export const sofficeName = isWindows ? 'soffice.exe' : 'soffice';

/** Archive folder name for each Node CPU architecture. */
const ARCHIVE_ARCH_DIRS = { x64: 'x86_64', arm64: 'aarch64', ia32: 'x86' };

const OS_NAMES = { win32: 'windows', linux: 'linux', darwin: 'mac' };

function readOsRelease() {
  try {
    const fields = {};
    for (const line of fs.readFileSync('/etc/os-release', 'utf8').split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) fields[match[1]] = match[2].replace(/^"|"$/g, '');
    }
    return fields;
  } catch {
    return {};
  }
}

function linuxPackageFamily(osRelease) {
  const ids = `${osRelease.ID ?? ''} ${osRelease.ID_LIKE ?? ''}`.toLowerCase();
  if (/debian|ubuntu|mint|pop/.test(ids)) return 'deb';
  if (/rhel|fedora|centos|ol|rocky|almalinux|suse|amzn/.test(ids)) return 'rpm';
  return null;
}

let cachedPlatform;

/**
 * {os, arch, archDir, packageFamily, distro, pretty, supported}.
 * packageFamily is 'deb' (Debian/Ubuntu) or 'rpm' (RHEL/Oracle/Fedora/SUSE) on Linux.
 */
export function detectPlatform() {
  if (cachedPlatform) return cachedPlatform;
  const platform = {
    os: OS_NAMES[process.platform] ?? process.platform,
    arch: process.arch,
    archDir: ARCHIVE_ARCH_DIRS[process.arch] ?? null,
    packageFamily: null,
    distro: null,
    pretty: `${process.platform} ${os.release()}`,
  };
  if (platform.os === 'windows') {
    platform.pretty = `Windows ${os.release()}`;
  } else if (platform.os === 'linux') {
    const osRelease = readOsRelease();
    platform.distro = osRelease.ID ?? null;
    platform.pretty = osRelease.PRETTY_NAME ?? 'Linux';
    platform.packageFamily = linuxPackageFamily(osRelease);
  }
  platform.supported = (platform.os === 'windows' || platform.os === 'linux') && platform.archDir !== null;
  cachedPlatform = platform;
  return platform;
}

/** Install methods available on this platform, preferred first. */
export function installMethods(platform = detectPlatform()) {
  if (platform.os === 'windows') return ['msi', 'portable'];
  if (platform.os === 'linux') return platform.packageFamily === 'rpm' ? ['rpm', 'deb'] : ['deb', 'rpm'];
  return [];
}
