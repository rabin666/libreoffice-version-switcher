import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './config.js';
import { fetchText } from './http.js';
import { detectPlatform, installMethods } from './platform.js';
import { compareVersions, isPrerelease, isVersionString, seriesOf } from './versions.js';

export const ARCHIVE_BASE = 'https://downloadarchive.documentfoundation.org/libreoffice/old/';

const VERSION_LIST_TTL = 6 * 60 * 60 * 1000;
const EMPTY_ARTIFACTS_TTL = 24 * 60 * 60 * 1000;

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const SIZE_UNITS = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

function parseListingDate(str) {
  const m = str.trim().match(/^(\d{2})-(\w{3})-(\d{4}) (\d{2}):(\d{2})$/);
  if (!m || MONTHS[m[2]] === undefined) return null;
  return new Date(Date.UTC(+m[3], MONTHS[m[2]], +m[1], +m[4], +m[5])).toISOString();
}

function parseListingSize(str) {
  const m = str.trim().match(/^([\d.]+)([KMG])?$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? SIZE_UNITS[m[2]] : 1));
}

/** Parse an Apache/mirrorbrain directory index into [{name, isDir, date, size}]. */
export function parseListing(html) {
  const rows = [];
  const rowRe = /<a href="([^"]+)">[^<]*<\/a><\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const href = m[1];
    if (/^(\?|\/|[a-z]+:)/i.test(href)) continue;
    const isDir = href.endsWith('/');
    rows.push({
      name: decodeURIComponent(isDir ? href.slice(0, -1) : href),
      isDir,
      date: parseListingDate(m[2]),
      size: isDir ? null : parseListingSize(m[3]),
    });
  }
  return rows;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {
    // cache is best effort
  }
}

/**
 * All versions in the archive, newest first:
 * [{version, series, prerelease, date}]
 */
export async function listRemoteVersions({ refresh = false, signal } = {}) {
  const file = path.join(cacheDir(), 'remote-versions.json');
  const cached = readJson(file);
  if (!refresh && cached && Date.now() - cached.fetchedAt < VERSION_LIST_TTL) return cached.versions;

  let html;
  try {
    html = await fetchText(ARCHIVE_BASE, { signal });
  } catch (err) {
    if (cached) return cached.versions; // offline: fall back to a stale list
    throw err;
  }
  const versions = parseListing(html)
    .filter((r) => r.isDir && isVersionString(r.name))
    .map((r) => ({ version: r.name, series: seriesOf(r.name), prerelease: isPrerelease(r.name), date: r.date }))
    .sort((a, b) => compareVersions(b.version, a.version));
  writeJson(file, { fetchedAt: Date.now(), versions });
  return versions;
}

const MAIN_FILE_RE = {
  msi: /^LibreOffice(Dev)?_[\w.]+_Win_(x86-64|x64|x86|aarch64)\.msi$/,
  deb: /^LibreOffice(Dev)?_[\w.]+_Linux_(x86-64|aarch64|x86)_deb\.tar\.gz$/,
  rpm: /^LibreOffice(Dev)?_[\w.]+_Linux_(x86-64|aarch64|x86)_rpm\.tar\.gz$/,
};

async function listDir(relPath, signal) {
  try {
    return parseListing(await fetchText(ARCHIVE_BASE + relPath, { signal }));
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

function artifact(method, relDir, row) {
  const url = ARCHIVE_BASE + relDir + encodeURIComponent(row.name);
  return { method, fileName: row.name, url, sha256Url: `${url}.sha256`, size: row.size, date: row.date };
}

async function findArtifact(version, method, platform, signal) {
  if (method === 'portable') {
    const relDir = `${version}/portable/`;
    const files = (await listDir(relDir, signal)).filter((r) => !r.isDir && r.name.endsWith('.paf.exe'));
    const pick =
      files.find((r) => /MultilingualStandard/.test(r.name)) ??
      files.find((r) => /MultilingualAll/.test(r.name)) ??
      files[0];
    return pick ? artifact('portable', relDir, pick) : null;
  }
  const osDir = method === 'msi' ? 'win' : method;
  const relDir = `${version}/${osDir}/${platform.archDir}/`;
  const pick = (await listDir(relDir, signal)).find((r) => !r.isDir && MAIN_FILE_RE[method].test(r.name));
  return pick ? artifact(method, relDir, pick) : null;
}

/**
 * Downloadable packages of `version` for this platform:
 * {version, artifacts: [{method, fileName, url, sha256Url, size, date}]}
 */
export async function getVersionArtifacts(version, { refresh = false, signal, platform = detectPlatform() } = {}) {
  if (!isVersionString(version)) throw new Error(`Invalid version "${version}"`);
  const file = path.join(cacheDir(), 'artifacts', `${version}-${platform.os}-${platform.archDir}.json`);
  const cached = readJson(file);
  if (
    !refresh &&
    cached &&
    (cached.artifacts.length > 0 || Date.now() - cached.fetchedAt < EMPTY_ARTIFACTS_TTL)
  ) {
    return { version, artifacts: cached.artifacts };
  }
  const methods = installMethods(platform);
  const found = await Promise.all(methods.map((m) => findArtifact(version, m, platform, signal)));
  const artifacts = found.filter(Boolean);
  writeJson(file, { fetchedAt: Date.now(), artifacts });
  return { version, artifacts };
}

/** SHA-256 published by the archive next to each file, or null if unavailable. */
export async function fetchSha256(art, signal) {
  try {
    const text = await fetchText(art.sha256Url, { signal, timeout: 15000 });
    return text.match(/^[a-f0-9]{64}/i)?.[0].toLowerCase() ?? null;
  } catch {
    return null;
  }
}
