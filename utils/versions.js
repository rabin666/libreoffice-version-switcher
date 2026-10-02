// Version strings. Archive versions look like "25.2.7.2" (final) or
// "26.2.0.0.beta1" (pre-release); users may type prefixes like "7.6".

const PRERELEASE_TAG = /(alpha|beta|rc)\d*$/i;

export function isVersionString(text) {
  return /^\d+\.\d+(\.\d+){0,2}(\.(alpha|beta|rc)\d*)?$/i.test(text);
}

export function isPrerelease(version) {
  return PRERELEASE_TAG.test(version);
}

/** "26.2.0.0.beta1" -> [26, 2, 0, 0] */
export function numericParts(version) {
  return String(version)
    .split('.')
    .filter((part) => /^\d+$/.test(part))
    .map(Number);
}

/** Sort comparator; a pre-release sorts before the final build with the same numbers. */
export function compareVersions(a, b) {
  const partsA = numericParts(a);
  const partsB = numericParts(b);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const difference = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (difference !== 0) return difference;
  }
  const tagA = String(a).match(PRERELEASE_TAG)?.[0] ?? '';
  const tagB = String(b).match(PRERELEASE_TAG)?.[0] ?? '';
  if (tagA === tagB) return 0;
  if (!tagA) return 1;
  if (!tagB) return -1;
  return tagA.localeCompare(tagB, undefined, { numeric: true });
}

/** "25.2.7.2" -> "25.2" */
export function seriesOf(version) {
  return numericParts(version).slice(0, 2).join('.');
}

/** "25.2.7.2" -> "25.2.7" */
export function shortVersion(version) {
  return numericParts(version).slice(0, 3).join('.');
}

/**
 * True when `version` matches a user spec such as "7.6", "7.6.5" or "7.6.5.2".
 * Pre-release specs must match exactly.
 */
export function matchesSpec(version, spec) {
  spec = String(spec).trim();
  if (isPrerelease(spec)) return version.toLowerCase() === spec.toLowerCase();
  const specParts = numericParts(spec);
  if (specParts.length === 0) return false;
  const versionParts = numericParts(version);
  return specParts.every((number, i) => versionParts[i] === number);
}

/** Newest final build matching `spec` ("latest" or empty = newest overall), or null. */
export function bestMatchingVersion(versions, spec) {
  const newestFirst = [...versions].sort(compareVersions).reverse();
  if (!spec || spec === 'latest') return newestFirst.find((v) => !isPrerelease(v)) ?? null;
  if (isPrerelease(spec)) return newestFirst.find((v) => matchesSpec(v, spec)) ?? null;
  return newestFirst.find((v) => !isPrerelease(v) && matchesSpec(v, spec)) ?? null;
}
