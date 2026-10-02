// Small filesystem helpers shared across modules.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isWindows } from './platform.js';

const GIB = 1024 ** 3;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Parsed JSON file, or null when missing or invalid. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Best-effort JSON write (used for caches, where failure is harmless). */
export function writeJsonQuietly(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {
    // cache only
  }
}

/** key=value pairs of an .ini / rc file (first occurrence wins); {} if unreadable. */
export function readIni(file) {
  const values = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([^=;#[\s][^=]*?)\s*=\s*(.*?)\s*$/);
      if (match && !(match[1] in values)) values[match[1]] = match[2];
    }
  } catch {
    // unreadable file reads as empty
  }
  return values;
}

/**
 * Absolute path for comparisons: no trailing separator (except a root such
 * as "/" or "C:\", which keeps it), lower-cased on Windows.
 */
export function normalizePath(target) {
  const resolved = path.resolve(target);
  const normalized = resolved === path.parse(resolved).root ? resolved : resolved.replace(/[\\/]+$/, '');
  return isWindows ? normalized.toLowerCase() : normalized;
}

/** True when `child` is `parent` or lies below it (lexical check). */
export function isInside(child, parent) {
  if (!parent) return false;
  const childPath = normalizePath(child);
  const parentPath = normalizePath(parent);
  const parentPrefix = parentPath.endsWith(path.sep) ? parentPath : parentPath + path.sep;
  return childPath === parentPath || childPath.startsWith(parentPrefix);
}

/** Path with every symlink/junction resolved, or null when it doesn't exist. */
export function realPath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

const TRANSIENT_LOCK_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Rename a folder, retrying while Windows briefly locks files; copies across volumes. */
export async function moveDir(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(source, destination);
      return;
    } catch (err) {
      if (err.code === 'EXDEV') {
        await fsp.cp(source, destination, { recursive: true });
        await fsp.rm(source, { recursive: true, force: true });
        return;
      }
      // Antivirus or the search indexer may hold files open for a moment.
      if (attempt >= 5 || !TRANSIENT_LOCK_ERRORS.has(err.code)) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
}

function freeBytes(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** Throw a readable error when `dir` has less than `neededBytes` free. */
export function assertFreeSpace(dir, neededBytes, purpose) {
  const available = freeBytes(dir);
  if (available === null || available >= neededBytes) return;
  const gib = (bytes) => (bytes / GIB).toFixed(1);
  throw new Error(`Not enough free space for ${purpose} in ${dir}: need about ${gib(neededBytes)} GB, have ${gib(available)} GB`);
}
