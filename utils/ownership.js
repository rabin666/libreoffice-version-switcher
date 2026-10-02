// Which installs lovs created, and so may replace or delete.
//
// Owned means: lovs metadata (.lovs.json) at the install root, AND the
// install's top folder really (links resolved) sits directly in installDir.
// Everything else — scan folders, system installs, folders a user dropped
// into installDir — is read-only to lovs.

import path from 'node:path';
import { isInside, normalizePath, readJson, realPath } from './fsutil.js';

export const METADATA_FILE = '.lovs.json';

/** Portable builds keep LibreOffice in <portable>/App/libreoffice; returns <portable> or null. */
export function portableRootOf(root) {
  const parts = path.resolve(root).split(path.sep);
  const count = parts.length;
  const isPortableLayout = count >= 3 && parts[count - 1].toLowerCase() === 'libreoffice' && parts[count - 2].toLowerCase() === 'app';
  return isPortableLayout ? parts.slice(0, count - 2).join(path.sep) : null;
}

/** The metadata lovs writes after a successful install, or null. */
export function readMetadata(root) {
  const metadata = readJson(path.join(root, METADATA_FILE));
  const valid = metadata && typeof metadata.method === 'string' && typeof metadata.version === 'string';
  return valid ? metadata : null;
}

/**
 * Real path of the folder lovs created for the install at `root` (the
 * portable folder, or `root` itself), or null when lovs doesn't own it.
 * This is the only folder uninstall or reinstall will ever remove.
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

/** Error explaining why lovs refuses to touch `dir`. */
export function notOwnedError(action, dir, root, installDir) {
  const reason = readMetadata(root)
    ? `its real location (${realPath(dir) ?? 'missing'}) is not directly inside the install folder (${realPath(installDir) ?? installDir})`
    : `it was not installed by lovs (no ${METADATA_FILE})`;
  return new Error(`${action} ${dir}: ${reason}. Nothing was deleted.`);
}
