// Version string helpers. LibreOffice archive versions look like
// "25.2.7.2" (final) or "26.2.0.0.beta1" (pre-release).

const PRE_RE = /(alpha|beta|rc)\d*$/i;

export function isVersionString(str) {
  return /^\d+\.\d+(\.\d+){0,2}(\.(alpha|beta|rc)\d*)?$/i.test(str);
}

export function isPrerelease(version) {
  return PRE_RE.test(version);
}

export function numericParts(version) {
  return String(version)
    .split('.')
    .filter((p) => /^\d+$/.test(p))
    .map(Number);
}

export function compareVersions(a, b) {
  const pa = numericParts(a);
  const pb = numericParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  // Same numbers: a pre-release sorts before the final build.
  const ta = String(a).match(PRE_RE)?.[0] ?? '';
  const tb = String(b).match(PRE_RE)?.[0] ?? '';
  if (ta === tb) return 0;
  if (!ta) return 1;
  if (!tb) return -1;
  return ta.localeCompare(tb, undefined, { numeric: true });
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
 * Pre-release specs ("26.8.0.0.beta1") must match exactly.
 */
export function matchesSpec(version, spec) {
  spec = String(spec).trim();
  if (isPrerelease(spec)) return version.toLowerCase() === spec.toLowerCase();
  const sp = numericParts(spec);
  if (sp.length === 0) return false;
  const vp = numericParts(version);
  return sp.every((n, i) => vp[i] === n);
}

/**
 * Pick the best version for a spec from a list: highest matching final build
 * ("latest" means the newest final build overall).
 */
export function resolveSpec(versions, spec) {
  const list = [...versions].sort(compareVersions).reverse();
  if (!spec || spec === 'latest') return list.find((v) => !isPrerelease(v)) ?? null;
  if (isPrerelease(spec)) return list.find((v) => matchesSpec(v, spec)) ?? null;
  return list.find((v) => !isPrerelease(v) && matchesSpec(v, spec)) ?? null;
}
