import fs from 'node:fs';
import os from 'node:os';

export const isWindows = process.platform === 'win32';

/** Directory name used by the archive for each CPU architecture. */
const ARCH_DIRS = { x64: 'x86_64', arm64: 'aarch64', ia32: 'x86' };

function readOsRelease() {
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    const out = {};
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

let cached;

/**
 * Describe the current machine in the terms the LibreOffice archive uses.
 * packageFamily is 'deb' on Debian/Ubuntu and 'rpm' on RHEL/Oracle/Fedora/SUSE.
 */
export function detectPlatform() {
  if (cached) return cached;
  const p = process.platform;
  const info = {
    os: p === 'win32' ? 'windows' : p === 'linux' ? 'linux' : p === 'darwin' ? 'mac' : p,
    arch: process.arch,
    archDir: ARCH_DIRS[process.arch] ?? null,
    packageFamily: null,
    distro: null,
    pretty: null,
  };
  if (info.os === 'windows') {
    info.pretty = `Windows ${os.release()}`;
  } else if (info.os === 'linux') {
    const rel = readOsRelease();
    const ids = `${rel.ID ?? ''} ${rel.ID_LIKE ?? ''}`.toLowerCase();
    info.distro = rel.ID ?? null;
    info.pretty = rel.PRETTY_NAME ?? 'Linux';
    if (/debian|ubuntu|mint|pop/.test(ids)) info.packageFamily = 'deb';
    else if (/rhel|fedora|centos|ol|rocky|almalinux|suse|amzn/.test(ids)) info.packageFamily = 'rpm';
  } else {
    info.pretty = `${p} ${os.release()}`;
  }
  info.supported = (info.os === 'windows' || info.os === 'linux') && info.archDir !== null;
  cached = info;
  return info;
}

/** Install methods available on this platform, preferred first. */
export function installMethods(platform = detectPlatform()) {
  if (platform.os === 'windows') return ['msi', 'portable'];
  if (platform.os === 'linux') return platform.packageFamily === 'rpm' ? ['rpm', 'deb'] : ['deb', 'rpm'];
  return [];
}

export const sofficeName = isWindows ? 'soffice.exe' : 'soffice';
