// Where an install keeps its user profile.
//
// LibreOffice reads `UserInstallation` from program/bootstrap.ini (Windows)
// or program/bootstraprc (Linux). The default points at the shared profile
// (%APPDATA%\LibreOffice, ~/.config/libreoffice); a $ORIGIN-relative value
// keeps it next to the install, so versions never share or corrupt a profile.

import fs from 'node:fs';
import path from 'node:path';
import { readIni } from './fsutil.js';

const BOOTSTRAP_FILES = ['bootstrap.ini', 'bootstraprc'];

/**
 * Per layout: the isolated UserInstallation value, and the folders (relative
 * to the install's top folder) to carry over when reinstalling.
 */
export const PROFILE_LAYOUTS = {
  standard: { userInstallation: '$ORIGIN/../user-profile', keep: ['user-profile'] },
  // Same place the PortableApps launcher uses: <portable>/Data/settings.
  portable: { userInstallation: '$ORIGIN/../../../Data/settings', keep: ['Data'] },
};

function bootstrapFile(programDir) {
  return BOOTSTRAP_FILES.map((name) => path.join(programDir, name)).find((file) => fs.existsSync(file)) ?? null;
}

export function readUserInstallation(programDir) {
  const file = bootstrapFile(programDir);
  return file ? (readIni(file).UserInstallation ?? null) : null;
}

/** True when the profile lives next to the install rather than in the shared location. */
export function hasIsolatedProfile(programDir) {
  return /^\$ORIGIN(\/|$)/.test(readUserInstallation(programDir) ?? '');
}

/** Set UserInstallation for the install at `root`, adding the key/section if missing. */
export function setUserInstallation(root, value) {
  const programDir = path.join(root, 'program');
  const file = bootstrapFile(programDir);
  if (!file) throw new Error(`No ${BOOTSTRAP_FILES.join('/')} in ${programDir}`);

  const text = fs.readFileSync(file, 'utf8');
  const line = `UserInstallation=${value}`;
  let updated;
  if (/^UserInstallation=.*$/m.test(text)) updated = text.replace(/^UserInstallation=.*$/m, line);
  else if (/^\[Bootstrap\][ \t]*$/m.test(text)) updated = text.replace(/^\[Bootstrap\][ \t]*$/m, (header) => `${header}\n${line}`);
  else updated = `[Bootstrap]\n${line}\n${text}`;
  fs.writeFileSync(file, updated);
}

/** Point the profile of a standard (MSI/deb/rpm) install at <install>/user-profile. */
export function isolateProfile(root) {
  setUserInstallation(root, PROFILE_LAYOUTS.standard.userInstallation);
}
