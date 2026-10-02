// The official LibreOffice archive: which versions exist and which package
// files each one has for this platform. Listings are cached on disk.

import path from 'node:path';
import { cacheDir } from './config.js';
import { readJson, writeJsonQuietly } from './fsutil.js';
import { fetchText } from './http.js';
import { detectPlatform, installMethods } from './platform.js';
import { compareVersions, isPrerelease, isVersionString, seriesOf } from './versions.js';

export const ARCHIVE_BASE = 'https://downloadarchive.documentfoundation.org/libreoffice/old/';

const VERSION_LIST_TTL_MS = 6 * 60 * 60 * 1000;
// Old builds are sometimes pruned; re-check "nothing found" only once a day.
const EMPTY_ARTIFACTS_TTL_MS = 24 * 60 * 60 * 1000;

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const SIZE_UNITS = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/** Main package file of each method (portable is picked separately). */
const PACKAGE_FILE_PATTERNS = {
  msi: /^LibreOffice(Dev)?_[\w.]+_Win_(x86-64|x64|x86|aarch64)\.msi$/,
  deb: /^LibreOffice(Dev)?_[\w.]+_Linux_(x86-64|aarch64|x86)_deb\.tar\.gz$/,
  rpm: /^LibreOffice(Dev)?_[\w.]+_Linux_(x86-64|aarch64|x86)_rpm\.tar\.gz$/,
};

/** "11-Dec-2025 11:02" -> ISO string */
function parseListingDate(text) {
  const match = text.trim().match(/^(\d{2})-(\w{3})-(\d{4}) (\d{2}):(\d{2})$/);
  if (!match || MONTHS[match[2]] === undefined) return null;
  const [, day, month, year, hour, minute] = match;
  return new Date(Date.UTC(+year, MONTHS[month], +day, +hour, +minute)).toISOString();
}

/** "348M" -> bytes */
function parseListingSize(text) {
  const match = text.trim().match(/^([\d.]+)([KMG])?$/);
  if (!match) return null;
  return Math.round(Number(match[1]) * (match[2] ? SIZE_UNITS[match[2]] : 1));
}

/** Rows of an Apache/MirrorBrain directory index: [{name, isDir, date, size}]. */
export function parseListing(html) {
  const rows = [];
  const rowPattern = /<a href="([^"]+)">[^<]*<\/a><\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/g;
  for (const [, href, date, size] of html.matchAll(rowPattern)) {
    // Skip sort links, the parent directory and absolute URLs.
    if (/^(\?|\/|[a-z]+:)/i.test(href)) continue;
    const isDir = href.endsWith('/');
    rows.push({
      name: decodeURIComponent(isDir ? href.slice(0, -1) : href),
      isDir,
      date: parseListingDate(date),
      size: isDir ? null : parseListingSize(size),
    });
  }
  return rows;
}

/** Every archived version, newest first: [{version, series, prerelease, date}]. */
export async function listRemoteVersions({ refresh = false, signal } = {}) {
  const cacheFile = path.join(cacheDir(), 'remote-versions.json');
  const cached = readJson(cacheFile);
  if (!refresh && cached && Date.now() - cached.fetchedAt < VERSION_LIST_TTL_MS) return cached.versions;

  let html;
  try {
    html = await fetchText(ARCHIVE_BASE, { signal });
  } catch (err) {
    if (cached) return cached.versions; // offline: a stale list beats none
    throw err;
  }
  const versions = parseListing(html)
    .filter((row) => row.isDir && isVersionString(row.name))
    .map((row) => ({ version: row.name, series: seriesOf(row.name), prerelease: isPrerelease(row.name), date: row.date }))
    .sort((a, b) => compareVersions(b.version, a.version));
  writeJsonQuietly(cacheFile, { fetchedAt: Date.now(), versions });
  return versions;
}

async function fetchListing(relativeDir, signal) {
  try {
    return parseListing(await fetchText(ARCHIVE_BASE + relativeDir, { signal }));
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

function toArtifact(method, relativeDir, row) {
  const url = ARCHIVE_BASE + relativeDir + encodeURIComponent(row.name);
  return { method, fileName: row.name, url, sha256Url: `${url}.sha256`, size: row.size, date: row.date };
}

async function findArtifact(version, method, platform, signal) {
  if (method === 'portable') {
    const relativeDir = `${version}/portable/`;
    const installers = (await fetchListing(relativeDir, signal)).filter((row) => !row.isDir && row.name.endsWith('.paf.exe'));
    // Standard (fewer languages) is much smaller than All.
    const chosen =
      installers.find((row) => /MultilingualStandard/.test(row.name)) ??
      installers.find((row) => /MultilingualAll/.test(row.name)) ??
      installers[0];
    return chosen ? toArtifact(method, relativeDir, chosen) : null;
  }
  const osDir = method === 'msi' ? 'win' : method;
  const relativeDir = `${version}/${osDir}/${platform.archDir}/`;
  const chosen = (await fetchListing(relativeDir, signal)).find((row) => !row.isDir && PACKAGE_FILE_PATTERNS[method].test(row.name));
  return chosen ? toArtifact(method, relativeDir, chosen) : null;
}

/** Packages of `version` for this platform: {version, artifacts: [{method, fileName, url, sha256Url, size, date}]}. */
export async function getVersionArtifacts(version, { refresh = false, signal, platform = detectPlatform() } = {}) {
  if (!isVersionString(version)) throw new Error(`Invalid version "${version}"`);
  const cacheFile = path.join(cacheDir(), 'artifacts', `${version}-${platform.os}-${platform.archDir}.json`);
  const cached = readJson(cacheFile);
  const cacheUsable = cached && (cached.artifacts.length > 0 || Date.now() - cached.fetchedAt < EMPTY_ARTIFACTS_TTL_MS);
  if (!refresh && cacheUsable) return { version, artifacts: cached.artifacts };

  const found = await Promise.all(installMethods(platform).map((method) => findArtifact(version, method, platform, signal)));
  const artifacts = found.filter(Boolean);
  writeJsonQuietly(cacheFile, { fetchedAt: Date.now(), artifacts });
  return { version, artifacts };
}

/** SHA-256 the archive publishes next to the file, or null when unavailable. */
export async function fetchSha256(artifact, signal) {
  try {
    const text = await fetchText(artifact.sha256Url, { signal, timeout: 15000 });
    return text.match(/^[a-f0-9]{64}/i)?.[0].toLowerCase() ?? null;
  } catch {
    return null;
  }
}
