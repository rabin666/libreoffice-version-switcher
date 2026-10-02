import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fetchWithTimeout } from './http.js';

const MB = 1024 * 1024;

/** HEAD request: final URL after redirects, size and range support. */
export async function probe(url, signal) {
  const res = await fetchWithTimeout(url, { method: 'HEAD', signal, timeout: 30000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const len = Number(res.headers.get('content-length'));
  return {
    finalUrl: res.url || url,
    size: Number.isFinite(len) && len > 0 ? len : null,
    acceptRanges: (res.headers.get('accept-ranges') || '').toLowerCase() === 'bytes',
  };
}

export async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * MB })) hash.update(chunk);
  return hash.digest('hex');
}

/** Aggregates byte counts from many workers and reports at most every 250 ms. */
export function progressTracker(total, onProgress) {
  let downloaded = 0;
  let lastEmit = 0;
  const samples = [];
  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    samples.push([now, downloaded]);
    while (samples.length > 1 && now - samples[0][0] > 5000) samples.shift();
    const [t0, b0] = samples[0];
    const speed = now > t0 ? ((downloaded - b0) * 1000) / (now - t0) : 0;
    onProgress?.({ downloaded, total, speed });
  };
  return {
    add(n) {
      downloaded += n;
      emit(false);
    },
    done: () => emit(true),
    get downloaded() {
      return downloaded;
    },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function downloadRange(url, fh, start, end, signal, tracker) {
  let pos = start;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: { Range: `bytes=${pos}-${end}` },
        signal,
        timeout: 10 * 60 * 1000,
      });
      if (res.status !== 206) throw new Error(`Server ignored range request (HTTP ${res.status})`);
      for await (const chunk of res.body) {
        const len = Math.min(chunk.length, end + 1 - pos);
        if (len <= 0) break;
        await fh.write(chunk, 0, len, pos);
        pos += len;
        tracker.add(len);
      }
      if (pos > end) return;
      throw new Error('Connection closed early');
    } catch (err) {
      if (signal?.aborted || attempt >= 5) throw err;
      await wait(1000 * (attempt + 1));
    }
  }
}

async function downloadSegmented(url, file, total, connections, signal, tracker) {
  const fh = await fsp.open(file, 'w');
  try {
    await fh.truncate(total);
    // Small pieces handed out from a queue, so fast connections take over
    // the work of slow ones instead of everyone waiting on the slowest.
    const pieceSize = Math.max(4 * MB, Math.ceil(total / (connections * 4)));
    const pieces = [];
    for (let s = 0; s < total; s += pieceSize) pieces.push([s, Math.min(s + pieceSize, total) - 1]);
    const worker = async () => {
      while (pieces.length) {
        const [s, e] = pieces.shift();
        await downloadRange(url, fh, s, e, signal, tracker);
      }
    };
    await Promise.all(Array.from({ length: Math.min(connections, pieces.length) }, worker));
  } finally {
    await fh.close();
  }
}

async function downloadSingle(url, file, signal, tracker) {
  const res = await fetchWithTimeout(url, { signal, timeout: 60 * 60 * 1000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const fh = await fsp.open(file, 'w');
  try {
    for await (const chunk of res.body) {
      await fh.write(chunk);
      tracker.add(chunk.length);
    }
  } finally {
    await fh.close();
  }
}

/**
 * Download `url` to `dest` using several parallel range requests when the
 * server supports them. Verifies size and (optionally) SHA-256. Re-uses an
 * already downloaded file when it matches.
 */
export async function downloadFile({ url, dest, connections = 6, signal, onProgress, sha256 }) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const info = await probe(url, signal);
  const total = info.size;

  if (total && fs.existsSync(dest) && fs.statSync(dest).size === total) {
    if (!sha256 || (await hashFile(dest)) === sha256) {
      onProgress?.({ downloaded: total, total, speed: 0 });
      return { dest, reused: true, size: total };
    }
  }

  const part = `${dest}.part`;
  const tracker = progressTracker(total, onProgress);
  try {
    if (total && info.acceptRanges && connections > 1 && total > 16 * MB) {
      await downloadSegmented(info.finalUrl, part, total, connections, signal, tracker);
    } else {
      await downloadSingle(info.finalUrl, part, signal, tracker);
    }
    tracker.done();
    const size = fs.statSync(part).size;
    if (total && size !== total) throw new Error(`Downloaded size ${size} does not match expected ${total}`);
    if (sha256) {
      const actual = await hashFile(part);
      if (actual !== sha256) throw new Error(`SHA-256 mismatch (expected ${sha256}, got ${actual})`);
    }
    await fsp.rm(dest, { force: true });
    await fsp.rename(part, dest);
    return { dest, reused: false, size };
  } catch (err) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw err;
  }
}
