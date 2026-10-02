// Many processes racing for one install lock: exactly one may win, both for
// a free lock and for a stale one left by a dead process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lovs-lockrace-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const lockModule = pathToFileURL(path.resolve('utils/lock.js')).href;
const worker = path.join(tmp, 'worker.mjs');
fs.writeFileSync(
  worker,
  `import { acquireInstallLock } from ${JSON.stringify(lockModule)};
const [dir, name, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {} // start everyone at the same moment
try {
  const release = await acquireInstallLock(dir, name);
  console.log('WON');
  await new Promise((r) => setTimeout(r, 1500)); // hold it while the others try
  release();
} catch (err) {
  console.log(/is busy/.test(err.message) ? 'BUSY' : 'ERR ' + err.message);
}
`,
);

function race(dir, name, n = 8) {
  const startAt = Date.now() + 1500;
  return Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [worker, dir, name, String(startAt)]);
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (out += d));
          child.on('close', () => resolve(out.trim()));
        }),
    ),
  );
}

describe('install lock across processes', () => {
  it('has exactly one winner for a free lock', async () => {
    const results = await race(path.join(tmp, 'free'), 'LibreOffice_7.6');
    expect(results.filter((r) => r === 'WON')).toHaveLength(1);
    expect(results.filter((r) => r !== 'WON' && r !== 'BUSY')).toEqual([]);
  }, 30000);

  it('has exactly one winner when taking over a stale lock', async () => {
    const dir = path.join(tmp, 'stale');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.lovs-lock-LibreOffice_7.6'), JSON.stringify({ pid: 999999999, token: 'dead' }));
    const results = await race(dir, 'LibreOffice_7.6');
    expect(results.filter((r) => r === 'WON')).toHaveLength(1);
    expect(results.filter((r) => r !== 'WON' && r !== 'BUSY')).toEqual([]);
  }, 30000);
});
