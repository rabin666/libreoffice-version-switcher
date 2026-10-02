// Built-in downloader against a local range-capable server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadFile } from '../utils/download.js';

const SIZE = 20 * 1024 * 1024; // above the 16 MB segmented threshold
const content = crypto.randomBytes(SIZE);
const tmp = fs.mkdtempSync(path.join(process.cwd(), 'tmpFiles', 'lovs-download-'));
let server;
let baseUrl;
let failFirstPiece = false;
let requestLog = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': SIZE, 'Accept-Ranges': 'bytes' });
      return res.end();
    }
    const [, start, end] = req.headers.range.match(/bytes=(\d+)-(\d+)/).map(Number);
    requestLog.push({ start, at: Date.now() });
    if (failFirstPiece && start === 0) {
      res.writeHead(500);
      return res.end();
    }
    res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${SIZE}` });
    // Slow pieces when testing failure, so siblings are still busy when piece 0 gives up.
    if (failFirstPiece) setTimeout(() => res.end(content.subarray(start, end + 1)), 10000);
    else res.end(content.subarray(start, end + 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/file.bin`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('downloadFile', () => {
  it('downloads in parallel pieces and verifies the SHA-256', async () => {
    failFirstPiece = false;
    requestLog = [];
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const dest = path.join(tmp, 'ok.bin');
    const result = await downloadFile({ url: baseUrl, dest, connections: 4, sha256 });
    expect(result).toMatchObject({ reused: false, size: SIZE });
    expect(requestLog.length).toBeGreaterThan(1);
    expect(fs.readFileSync(dest).equals(content)).toBe(true);
    fs.rmSync(dest); // the system drive may be nearly full
  });

  it('stops every other connection once one piece fails for good', async () => {
    failFirstPiece = true;
    requestLog = [];
    const dest = path.join(tmp, 'fail.bin');
    // Two connections: the sibling still has several slow pieces queued when piece 0 gives up.
    await expect(downloadFile({ url: baseUrl, dest, connections: 2 })).rejects.toThrow(/HTTP 500/);
    const rejectedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 12000));
    expect(requestLog.filter((request) => request.at > rejectedAt)).toEqual([]);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  }, 60000);
});
