// Pure helpers for the install records returned by GET /api/local.

export const INSTALL_KIND_LABEL = {
  msi: 'MSI extract',
  portable: 'portable',
  deb: 'deb extract',
  rpm: 'rpm extract',
  system: 'system',
  extracted: 'folder',
};

const SOURCE_DESCRIPTION = {
  managed: 'Installed by lovs',
  scanned: 'Found in a scan folder',
};

export const describeSource = (source) => SOURCE_DESCRIPTION[source] ?? 'System install';

/** The folder the user thinks of as "the install" (portable builds nest the program inside). */
export const installLocation = (install) => install.portableRoot ?? install.root;

export function matchesInstallFilter(install, query) {
  return `${install.version} ${install.root} ${install.kind} ${install.source}`.toLowerCase().includes(query);
}

const normalizeDir = (dir) => dir.replace(/[\\/]+$/, '').toLowerCase();

/** Version of the install that owns `dir` (its program folder or anything below its root), or null. */
export function findVersionForDir(installs, dir) {
  if (!dir || !installs) return null;
  const target = normalizeDir(dir);
  const owner = installs.find(
    (install) => normalizeDir(install.programDir) === target || target.startsWith(normalizeDir(install.root)),
  );
  return owner?.version ?? null;
}
