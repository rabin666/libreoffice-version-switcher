// Regression tests for install/uninstall safety, cancellation and the server.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitInstall, uninstall } from '../utils/install.js';
import { acquireInstallLock } from '../utils/lock.js';
import { hasIsolatedProfile, setUserInstallation } from '../utils/profile.js';
import { installFromPath, scanLocalInstalls } from '../utils/local.js';
import { sofficeName } from '../utils/platform.js';
import { runCommand } from '../utils/proc.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lovs-safety-'));
process.env.LOVS_HOME = path.join(tmp, 'home');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeInstall(root, { meta = true, bootstrap = '[Bootstrap]\nUserInstallation=$SYSUSERCONFIG/LibreOffice/4\n' } = {}) {
  const program = path.join(root, 'program');
  fs.mkdirSync(program, { recursive: true });
  fs.writeFileSync(path.join(program, sofficeName), '');
  fs.writeFileSync(path.join(program, 'bootstrap.ini'), bootstrap);
  if (meta) fs.writeFileSync(path.join(root, '.lovs.json'), JSON.stringify({ version: '7.5.9.2', method: 'msi' }));
  return root;
}

/** Directory link that works without admin rights on Windows. */
const link = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');

describe('ownership', () => {
  const installDir = path.join(tmp, 'own', 'versions');
  const config = { installDir, scanDirs: [] };
  const unmarked = fakeInstall(path.join(installDir, 'LibreOffice_7.5'), { meta: false });
  const marked = fakeInstall(path.join(installDir, 'LibreOffice_7.6'));
  const nested = fakeInstall(path.join(installDir, 'sub', 'LibreOffice_7.4'));

  it('only treats installs with lovs metadata as managed', async () => {
    const list = await scanLocalInstalls(config, { probe: false });
    const byRoot = Object.fromEntries(list.map((i) => [path.basename(i.root), i]));
    expect(byRoot['LibreOffice_7.5']).toMatchObject({ managed: false, source: 'scanned' });
    expect(byRoot['LibreOffice_7.6']).toMatchObject({ managed: true, source: 'managed' });
  });

  it('agrees with uninstall about nested folders', async () => {
    const inst = installFromPath(nested, config);
    expect(inst.managed).toBe(false);
    await expect(uninstall(inst, config)).rejects.toThrow(/real location/);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('refuses to uninstall an install lovs did not create', async () => {
    await expect(uninstall(installFromPath(unmarked, config), config)).rejects.toThrow(/not installed by lovs/);
    expect(fs.existsSync(unmarked)).toBe(true);
  });

  it('uninstalls its own installs', async () => {
    const res = await uninstall(installFromPath(marked, config), config);
    expect(fs.existsSync(marked)).toBe(false);
    expect(res.removed).toBeTruthy();
  });
});

describe('links out of the install folder', () => {
  const installDir = path.join(tmp, 'links', 'versions');
  const outside = path.join(tmp, 'links', 'outside');
  const config = { installDir, scanDirs: [] };
  const victim = fakeInstall(path.join(outside, 'LibreOffice_7.5'));
  fs.mkdirSync(installDir, { recursive: true });
  link(outside, path.join(installDir, 'linked'));
  link(victim, path.join(installDir, 'LibreOffice_7.5'));

  it('does not mark linked installs as managed', async () => {
    const list = await scanLocalInstalls(config, { probe: false });
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((i) => !i.managed)).toBe(true);
  });

  it('refuses to delete through a link inside a subfolder', async () => {
    const inst = { ...installFromPath(path.join(installDir, 'linked', 'LibreOffice_7.5'), config), managed: true };
    await expect(uninstall(inst, config)).rejects.toThrow(/real location/);
    expect(fs.existsSync(path.join(victim, 'program', sofficeName))).toBe(true);
  });

  it('refuses to delete a top-level link to another folder', async () => {
    const inst = { ...installFromPath(path.join(installDir, 'LibreOffice_7.5'), config), managed: true };
    await expect(uninstall(inst, config)).rejects.toThrow(/real location/);
    expect(fs.existsSync(path.join(victim, 'program', sofficeName))).toBe(true);
  });
});

describe('commitInstall (reinstall)', () => {
  const allow = () => {};
  const base = path.join(tmp, 'commit');
  const setup = (name) => {
    const target = fakeInstall(path.join(base, name, 'LibreOffice_25.2'));
    fs.writeFileSync(path.join(target, 'old.txt'), 'old');
    fs.mkdirSync(path.join(target, 'user-profile'));
    fs.writeFileSync(path.join(target, 'user-profile', 'registrymodifications.xcu'), 'settings');
    const staged = fakeInstall(path.join(base, name, 'stage'));
    fs.writeFileSync(path.join(staged, 'new.txt'), 'new');
    return { target, staged, dir: path.join(base, name) };
  };

  it('replaces the install and keeps its profile', async () => {
    const { target, staged, dir } = setup('ok');
    await commitInstall(staged, target, { keep: ['user-profile'], assertReplaceable: allow });
    expect(fs.existsSync(path.join(target, 'new.txt'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'old.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(target, 'user-profile', 'registrymodifications.xcu'), 'utf8')).toBe('settings');
    expect(fs.readdirSync(dir).filter((n) => n.includes('lovs-old'))).toEqual([]);
  });

  it('restores the previous install when replacing fails', async () => {
    const { target, dir } = setup('fail');
    await expect(commitInstall(path.join(dir, 'missing-stage'), target, { keep: ['user-profile'], assertReplaceable: allow })).rejects.toThrow(/ENOENT|no such file/);
    expect(fs.existsSync(path.join(target, 'old.txt'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'user-profile', 'registrymodifications.xcu'))).toBe(true);
    expect(fs.readdirSync(dir).filter((n) => n.includes('lovs-old'))).toEqual([]);
  });

  it('never replaces a folder that appeared after the up-front checks', async () => {
    const { target, staged } = setup('appeared');
    await expect(commitInstall(staged, target, { keep: ['user-profile'] })).rejects.toThrow(/already exists/);
    const deny = () => {
      throw new Error('Not replacing: not installed by lovs');
    };
    await expect(commitInstall(staged, target, { assertReplaceable: deny })).rejects.toThrow(/Not replacing/);
    expect(fs.existsSync(path.join(target, 'old.txt'))).toBe(true);
    expect(fs.existsSync(path.join(staged, 'new.txt'))).toBe(true);
  });

  it('does nothing once cancelled', async () => {
    const { target, staged } = setup('cancel');
    const ac = new AbortController();
    ac.abort();
    await expect(commitInstall(staged, target, { signal: ac.signal, assertReplaceable: allow })).rejects.toThrow();
    expect(fs.existsSync(path.join(target, 'old.txt'))).toBe(true);
  });
});

describe('install lock', () => {
  const dir = path.join(tmp, 'lock');

  it('allows one install of a target at a time', async () => {
    const release = await acquireInstallLock(dir, 'LibreOffice_7.6');
    await expect(acquireInstallLock(dir, 'LibreOffice_7.6')).rejects.toThrow(/is busy/);
    const other = await acquireInstallLock(dir, 'LibreOffice_25.2');
    other();
    release();
    (await acquireInstallLock(dir, 'LibreOffice_7.6'))();
  });

  it('takes over a lock left by a process that is gone', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.lovs-lock-LibreOffice_6.4'), JSON.stringify({ pid: 999999999, token: 'x' }));
    (await acquireInstallLock(dir, 'LibreOffice_6.4'))();
  });

  it('treats an empty lock as being written, not as stale', async () => {
    const file = path.join(dir, '.lovs-lock-LibreOffice_5.4');
    fs.writeFileSync(file, '');
    await expect(acquireInstallLock(dir, 'LibreOffice_5.4')).rejects.toThrow(/is busy/);
    // ...until it has been empty for longer than any writer could take
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    (await acquireInstallLock(dir, 'LibreOffice_5.4'))();
  });

  it('release never removes a lock someone else now holds', async () => {
    const release = await acquireInstallLock(dir, 'LibreOffice_5.3');
    const file = path.join(dir, '.lovs-lock-LibreOffice_5.3');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'someone-else' }));
    release();
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(file);
  });

  it('blocks uninstall while the install folder is locked', async () => {
    const installDir = path.join(tmp, 'lock-un', 'versions');
    const config = { installDir, scanDirs: [] };
    const root = fakeInstall(path.join(installDir, 'LibreOffice_7.3'));
    const release = await acquireInstallLock(installDir, 'LibreOffice_7.3');
    try {
      await expect(uninstall(installFromPath(root, config), config)).rejects.toThrow(/is busy/);
      expect(fs.existsSync(root)).toBe(true);
    } finally {
      release();
    }
    await uninstall(installFromPath(root, config), config);
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe('profile isolation', () => {
  it('rewrites the default shared profile location', () => {
    const root = fakeInstall(path.join(tmp, 'profile', 'a'));
    expect(hasIsolatedProfile(path.join(root, 'program'))).toBe(false);
    setUserInstallation(root, '$ORIGIN/../../../Data/settings');
    expect(hasIsolatedProfile(path.join(root, 'program'))).toBe(true);
  });

  it('adds the setting when bootstrap.ini has no section header', () => {
    const root = fakeInstall(path.join(tmp, 'profile', 'b'), { bootstrap: 'ProductKey=LibreOffice\n' });
    setUserInstallation(root, '$ORIGIN/../user-profile');
    expect(hasIsolatedProfile(path.join(root, 'program'))).toBe(true);
  });
});

describe('cancellation', () => {
  it('does not start a process for an already-cancelled signal', async () => {
    const marker = path.join(tmp, 'spawned.txt');
    const ac = new AbortController();
    ac.abort();
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`;
    await expect(runCommand(process.execPath, ['-e', script], { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('web server', () => {
  let srv;
  beforeAll(async () => {
    const { startServer } = await import('../api/server.js');
    const log = console.log;
    console.log = () => {};
    try {
      srv = await startServer({ port: 0, open: false });
    } finally {
      console.log = log;
    }
  });
  afterAll(() => srv?.server.close());

  const get = (p) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: srv.port, path: p }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });

  it('answers malformed URLs with 400 and keeps running', async () => {
    expect(await get('/%ZZ')).toBe(400);
    expect(await get('/api/remote/%ZZ?token=x')).toBe(401);
    expect(await get('/api/session')).toBe(200);
  });
});
