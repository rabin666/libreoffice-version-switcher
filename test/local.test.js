import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isInside } from '../utils/fsutil.js';
import { matchInstall, scanLocalInstalls, versionFromPath } from '../utils/local.js';
import { sofficeName } from '../utils/platform.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lovs-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeInstall(root, { versionIni, meta } = {}) {
  const program = path.join(root, 'program');
  fs.mkdirSync(program, { recursive: true });
  fs.writeFileSync(path.join(program, sofficeName), '');
  fs.writeFileSync(path.join(program, 'bootstrap.ini'), '[Bootstrap]\n');
  if (versionIni) fs.writeFileSync(path.join(program, 'version.ini'), `[Version]\nMsiProductVersion=${versionIni}\n`);
  if (meta) fs.writeFileSync(path.join(root, '.lovs.json'), JSON.stringify(meta));
}

describe('local scan', () => {
  const installDir = path.join(tmp, 'versions');
  const scanDir = path.join(tmp, 'portable');
  fakeInstall(path.join(installDir, 'LibreOffice_25.2.7.2'), { meta: { version: '25.2.7.2', method: 'msi' } });
  fakeInstall(path.join(scanDir, 'LibreOfficePortablePrevious_7.6.5', 'App', 'libreoffice'), { versionIni: '7.6.5.2' });
  fakeInstall(path.join(scanDir, 'LibreOfficePortablePrevious_7.6.7.2', 'App', 'libreoffice'), { versionIni: '7.6.7.2' });

  // The scan also covers system locations; keep only this test's fixtures so
  // a machine with LibreOffice installed (e.g. /usr/lib/libreoffice) passes too.
  const scanFixtures = async () =>
    (await scanLocalInstalls({ installDir, scanDirs: [scanDir] }, { probe: false })).filter((install) => isInside(install.root, tmp));

  it('finds managed and portable installs with versions', async () => {
    const list = await scanFixtures();
    expect(list.map((i) => i.version)).toEqual(['25.2.7.2', '7.6.7.2', '7.6.5.2']);
    expect(list[0]).toMatchObject({ source: 'managed', kind: 'msi' });
    expect(list[1]).toMatchObject({ source: 'scanned', kind: 'portable', label: 'LibreOfficePortablePrevious_7.6.7.2' });
  });

  it('resolves version prefixes to the newest match', async () => {
    const list = await scanFixtures();
    expect(matchInstall(list, '7.6').version).toBe('7.6.7.2');
    expect(matchInstall(list, '7.6.5').version).toBe('7.6.5.2');
    expect(() => matchInstall(list, '6.4')).toThrow(/No local install/);
  });

  it('reads versions from folder names', () => {
    expect(versionFromPath('/opt/libreoffice25.2')).toBe('25.2');
    expect(versionFromPath('D:\\x\\LibreOffice_24.8.7.2')).toBe('24.8.7.2');
  });
});
