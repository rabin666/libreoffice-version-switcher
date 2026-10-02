// Filtering and grouping of the remote version list (GET /api/remote).

const numericParts = (version) =>
  version
    .split('.')
    .filter((part) => /^\d+$/.test(part))
    .map(Number);

/** True when `version` starts with `query`, or its leading numeric parts equal the query's. */
function versionMatchesQuery(version, query) {
  if (version.startsWith(query)) return true;
  const queryParts = numericParts(query);
  const versionParts = numericParts(version);
  return queryParts.length > 0 && queryParts.every((part, index) => versionParts[index] === part);
}

/** Groups builds by series, keeping the server's order (newest first). */
export function groupBySeries(versions, { query, includePrereleases }) {
  const buildsBySeries = new Map();
  for (const build of versions) {
    if (!includePrereleases && build.prerelease) continue;
    if (query && !versionMatchesQuery(build.version, query)) continue;
    if (!buildsBySeries.has(build.series)) buildsBySeries.set(build.series, []);
    buildsBySeries.get(build.series).push(build);
  }
  return [...buildsBySeries.entries()].map(([series, builds]) => ({ series, builds }));
}

/** The series of the newest stable build, which is expanded by default. */
export const newestStableSeries = (versions) =>
  versions
    .filter((build) => !build.prerelease)
    .slice(0, 1)
    .map((build) => build.series);
