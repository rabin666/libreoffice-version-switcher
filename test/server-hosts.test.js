// Host-header allow-list: blocks DNS rebinding, but a wildcard bind
// (--host 0.0.0.0) must still be reachable through this machine's own addresses.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

process.env.LOVS_HOME = path.join(os.tmpdir(), `lovs-hosts-${process.pid}`);
const { startServer } = await import('../api/server.js');

const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((entry) => entry && (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)?.address;

const servers = [];
async function start(host) {
  const log = console.log;
  console.log = () => {};
  try {
    const started = await startServer({ host, port: 0, open: false });
    servers.push(started.server);
    return started.port;
  } finally {
    console.log = log;
  }
}
afterAll(() => servers.forEach((server) => server.close()));

/** Status of GET /api/session sent to 127.0.0.1 with a chosen Host header. */
function statusFor(port, hostHeader) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/api/session', headers: { Host: hostHeader } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject);
  });
}

describe('Host header check', () => {
  it('accepts only loopback names by default', async () => {
    const port = await start('127.0.0.1');
    expect(await statusFor(port, `localhost:${port}`)).toBe(200);
    expect(await statusFor(port, `evil.example:${port}`)).toBe(403);
    if (lanAddress) expect(await statusFor(port, `${lanAddress}:${port}`)).toBe(403);
  });

  it('accepts this machine\'s own addresses when bound to all interfaces, but no foreign names', async () => {
    const port = await start('0.0.0.0');
    expect(await statusFor(port, `127.0.0.1:${port}`)).toBe(200);
    expect(await statusFor(port, `${os.hostname()}:${port}`)).toBe(200);
    if (lanAddress) expect(await statusFor(port, `${lanAddress}:${port}`)).toBe(200);
    expect(await statusFor(port, `evil.example:${port}`)).toBe(403);
  });
});
