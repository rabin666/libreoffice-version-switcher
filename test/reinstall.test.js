// `install --force` must not touch the existing install when the new one
// can't be fetched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/remote.js', () => ({
  getVersionArtifacts: async () => ({
    artifacts: [{ method: 'portable', fileName: 'x.paf.exe', url: 'https://example.invalid/x.paf.exe', sha256Url: '', size: 1 }],
  }),
  fetchSha256: async () => null,
}));
vi.mock('../utils/download.js', async (importOriginal) => ({
  ...(await importOriginal()),
  probeUrl: async () => {
    throw new Error('network down');
  },
}));

const { installVersion, installFolderName } = await import('../utils/install.js');
const { detectPlatform } = await import('../utils/platform.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lovs-reinstall-'));
process.env.LOVS_HOME = path.join(tmp, 'home');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe.runIf(detectPlatform().supported)('installVersion --force', () => {
  const config = { installDir: path.join(tmp, 'versions'), downloadDir: path.join(tmp, 'dl'), connections: 1, downloader: 'builtin' };
  const target = path.join(config.installDir, installFolderName('7.6.7.2', 'portable'));
  const profile = path.join(target, 'Data', 'settings', 'profile.xcu');
  const install = () => installVersion({ version: '7.6.7.2', method: 'portable', config, force: true });

  it('refuses to replace a folder lovs did not create', async () => {
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.writeFileSync(profile, 'mine');
    await expect(install()).rejects.toThrow(/Not replacing .*not installed by lovs/);
    expect(fs.readFileSync(profile, 'utf8')).toBe('mine');
  });

  it('keeps its own existing install when the download fails', async () => {
    const root = path.join(target, 'App', 'libreoffice');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.lovs.json'), JSON.stringify({ version: '7.6.7.2', method: 'portable' }));
    await expect(install()).rejects.toThrow('network down');
    expect(fs.readFileSync(profile, 'utf8')).toBe('mine');
  });
});
