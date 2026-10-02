// Cross-process lock on one install folder, shared by install and uninstall
// in every lovs process (CLI and web UI).
//
// A lock is a file `<installDir>/.lovs-lock-<name>` holding {pid, token}.
//  - It appears with its content in one step (hard link of a finished temp
//    file), so nobody can mistake a half-written lock for a stale one.
//  - A lock whose process has exited is stale and may be taken over. Takeover
//    is serialized through `<lock>.break` and re-checks the content, so a
//    lock created in the meantime is never removed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './fsutil.js';

// A lock without a readable owner counts as "being written" until this old.
const GRACE_MS = 30_000;
const MAX_ATTEMPTS = 50;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by another user
  }
}

/** {text, owner, ageMs} of a lock file, or null when it doesn't exist. */
function readLock(file) {
  let text;
  let modifiedAt;
  try {
    text = fs.readFileSync(file, 'utf8');
    modifiedAt = fs.statSync(file).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let owner = null;
  try {
    const parsed = JSON.parse(text);
    if (Number.isInteger(parsed?.pid)) owner = parsed;
  } catch {
    // empty or partly written
  }
  return { text, owner, ageMs: Date.now() - modifiedAt };
}

function isAbandoned(lock) {
  if (!lock.owner) return lock.ageMs > GRACE_MS;
  return lock.owner.pid !== process.pid && !isProcessAlive(lock.owner.pid);
}

/** Create `file` with `content`; false if it already exists. Never visible empty. */
function createExclusive(file, content) {
  const tempFile = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tempFile, content, { flag: 'wx' });
  try {
    fs.linkSync(tempFile, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    // No hard links (FAT/exFAT, some network shares): plain exclusive create.
    // Readers treat its brief empty state as "being written".
    try {
      fs.writeFileSync(file, content, { flag: 'wx' });
      return true;
    } catch (fallbackErr) {
      if (fallbackErr.code === 'EEXIST') return false;
      throw fallbackErr;
    }
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
}

/** Remove `file` only if it still holds `staleText`; one breaker at a time. */
function breakStaleLock(file, staleText) {
  const breakerFile = `${file}.break`;
  if (!createExclusive(breakerFile, JSON.stringify({ pid: process.pid, at: Date.now() }))) {
    // Breakers hold their file for microseconds; an old or orphaned one crashed.
    const breaker = readLock(breakerFile);
    if (breaker && (breaker.ageMs > GRACE_MS || (breaker.owner && !isProcessAlive(breaker.owner.pid)))) {
      fs.rmSync(breakerFile, { force: true });
    }
    return;
  }
  try {
    if (readLock(file)?.text === staleText) fs.rmSync(file, { force: true });
  } finally {
    fs.rmSync(breakerFile, { force: true });
  }
}

function busyError(name, lock, file) {
  const holder =
    lock.owner?.pid === process.pid ? 'this lovs process' : lock.owner ? `another lovs process (pid ${lock.owner.pid})` : 'another lovs process';
  return new Error(`${name} is busy: ${holder} is installing or uninstalling it. Wait for it to finish (or delete ${file} if no lovs is running).`);
}

/** Lock install folder `name` inside `installDir`. Resolves with a release function. */
export async function acquireInstallLock(installDir, name) {
  await fsp.mkdir(installDir, { recursive: true });
  const file = path.join(installDir, `.lovs-lock-${name}`);
  const ownContent = JSON.stringify({ pid: process.pid, token: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString() });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (createExclusive(file, ownContent)) {
      return () => {
        if (readLock(file)?.text === ownContent) fs.rmSync(file, { force: true });
      };
    }
    const lock = readLock(file);
    if (!lock) continue; // released in the meantime
    if (!isAbandoned(lock)) throw busyError(name, lock, file);
    breakStaleLock(file, lock.text);
    await sleep(20 + Math.random() * 80);
  }
  throw new Error(`Could not lock ${file}`);
}
