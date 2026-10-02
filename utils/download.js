// Built-in downloader: parallel HTTP range requests with retries, size and
// SHA-256 verification, and re-use of a matching earlier download.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './fsutil.js';
import { fetchWithTimeout } from './http.js';

const MB = 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;
const SPEED_WINDOW_MS = 5000;
const RANGE_RETRIES = 5;
// Below this, one connection is as fast as several.
const SEGMENTED_MIN_BYTES = 16 * MB;

/** HEAD request: final URL after redirects, size, and whether ranges are supported. */
export async function probeUrl(url, signal) {
  const response = await fetchWithTimeout(url, { method: 'HEAD', signal, timeout: 30000 });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const length = Number(response.headers.get('content-length'));
  return {
    finalUrl: response.url || url,
    size: Number.isFinite(length) && length > 0 ? length : null,
    acceptRanges: (response.headers.get('accept-ranges') || '').toLowerCase() === 'bytes',
  };
}

export async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * MB })) hash.update(chunk);
  return hash.digest('hex');
}

/** Sums bytes from all connections; reports {downloaded, total, speed} at most every 250 ms. */
export function progressTracker(total, onProgress) {
  let downloaded = 0;
  let lastReport = 0;
  const samples = []; // [time, bytes] over the last few seconds, for the speed
  const report = (force) => {
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    samples.push([now, downloaded]);
    while (samples.length > 1 && now - samples[0][0] > SPEED_WINDOW_MS) samples.shift();
    const [sampleTime, sampleBytes] = samples[0];
    const speed = now > sampleTime ? ((downloaded - sampleBytes) * 1000) / (now - sampleTime) : 0;
    onProgress?.({ downloaded, total, speed });
  };
  return {
    add(bytes) {
      downloaded += bytes;
      report(false);
    },
    finish: () => report(true),
  };
}

/** Download bytes [start, end] into `fileHandle`, resuming after dropped connections. */
async function downloadRange(url, fileHandle, start, end, signal, tracker) {
  let position = start;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchWithTimeout(url, { headers: { Range: `bytes=${position}-${end}` }, signal, timeout: 10 * 60 * 1000 });
      if (response.status !== 206) throw new Error(`Server ignored range request (HTTP ${response.status})`);
      for await (const chunk of response.body) {
        const length = Math.min(chunk.length, end + 1 - position);
        if (length <= 0) break;
        await fileHandle.write(chunk, 0, length, position);
        position += length;
        tracker.add(length);
      }
      if (position > end) return;
      throw new Error('Connection closed early');
    } catch (err) {
      if (signal?.aborted || attempt >= RANGE_RETRIES) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
}

async function downloadSegmented(url, file, total, connections, signal, tracker) {
  const fileHandle = await fsp.open(file, 'w');
  try {
    await fileHandle.truncate(total);
    // Many small pieces from a shared queue, so fast connections pick up the
    // slack of slow ones instead of everyone waiting for the slowest.
    const pieceSize = Math.max(4 * MB, Math.ceil(total / (connections * 4)));
    const pieces = [];
    for (let start = 0; start < total; start += pieceSize) pieces.push([start, Math.min(start + pieceSize, total) - 1]);

    // The first permanent failure stops every other connection, and all of
    // them settle before the file is closed: nothing keeps downloading or
    // writes to a closed handle after this function has rejected.
    const stopOthers = new AbortController();
    const pieceSignal = signal ? AbortSignal.any([signal, stopOthers.signal]) : stopOthers.signal;
    let firstError = null;
    const worker = async () => {
      while (pieces.length && !pieceSignal.aborted) {
        const [start, end] = pieces.shift();
        try {
          await downloadRange(url, fileHandle, start, end, pieceSignal, tracker);
        } catch (err) {
          firstError ??= err;
          stopOthers.abort();
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(connections, pieces.length) }, worker));
    if (firstError) throw firstError;
    signal?.throwIfAborted();
  } finally {
    await fileHandle.close();
  }
}

async function downloadSingle(url, file, signal, tracker) {
  const response = await fetchWithTimeout(url, { signal, timeout: 60 * 60 * 1000 });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const fileHandle = await fsp.open(file, 'w');
  try {
    for await (const chunk of response.body) {
      await fileHandle.write(chunk);
      tracker.add(chunk.length);
    }
  } finally {
    await fileHandle.close();
  }
}

/**
 * Download `url` to `dest` (via `<dest>.part`), verifying size and optional
 * SHA-256. Resolves with {dest, reused, size}.
 */
export async function downloadFile({ url, dest, connections = 6, signal, onProgress, sha256 }) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const remote = await probeUrl(url, signal);
  const total = remote.size;

  if (total && fs.existsSync(dest) && fs.statSync(dest).size === total) {
    if (!sha256 || (await hashFile(dest)) === sha256) {
      onProgress?.({ downloaded: total, total, speed: 0 });
      return { dest, reused: true, size: total };
    }
  }

  const partFile = `${dest}.part`;
  const tracker = progressTracker(total, onProgress);
  try {
    const segmented = total && remote.acceptRanges && connections > 1 && total > SEGMENTED_MIN_BYTES;
    if (segmented) await downloadSegmented(remote.finalUrl, partFile, total, connections, signal, tracker);
    else await downloadSingle(remote.finalUrl, partFile, signal, tracker);
    tracker.finish();

    const size = fs.statSync(partFile).size;
    if (total && size !== total) throw new Error(`Downloaded size ${size} does not match expected ${total}`);
    if (sha256) {
      const actual = await hashFile(partFile);
      if (actual !== sha256) throw new Error(`SHA-256 mismatch (expected ${sha256}, got ${actual})`);
    }
    await fsp.rm(dest, { force: true });
    await fsp.rename(partFile, dest);
    return { dest, reused: false, size };
  } catch (err) {
    await fsp.rm(partFile, { force: true }).catch(() => {});
    throw err;
  }
}
