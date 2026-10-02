// Suggested commands must select the same install again, whether it was
// found by a scan or given as a folder no scan covers.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toMsysPath, subshellPlan } from '../utils/envcmd.js';
import { resolveInstall, scanLocalInstalls, selectorFor } from '../utils/local.js';
import { isWindows, sofficeName } from '../utils/platform.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lovs-hints-'));
process.env.LOVS_HOME = path.join(tmp, 'home');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeInstall(root, version) {
  const program = path.join(root, 'program');
  fs.mkdirSync(program, { recursive: true });
  fs.writeFileSync(path.join(program, sofficeName), '');
  fs.writeFileSync(path.join(program, 'bootstrap.ini'), '[Bootstrap]\n');
  fs.writeFileSync(path.join(program, 'version.ini'), `[Version]\nMsiProductVersion=${version}\n`);
  if (!isWindows) fs.writeFileSync(path.join(program, 'bootstraprc'), '[Bootstrap]\n');
  return root;
}

const installDir = path.join(tmp, 'versions');
const config = { installDir, scanDirs: [] };
fakeInstall(path.join(installDir, 'LibreOffice_25.2.7.2'), '25.2.7.2');
fakeInstall(path.join(installDir, 'LibreOffice_7.6.7.2'), '7.6.7.2');
fakeInstall(path.join(installDir, 'LibreOffice_7.6.7.2_copy'), '7.6.7.2');
const external = fakeInstall(path.join(tmp, 'elsewhere', "Office $TEAM it's"), '24.8.7.2');

describe('selectorFor', () => {
  const roundTrip = async (inst) => {
    const installs = await scanLocalInstalls(config, { probe: false });
    const spec = selectorFor(inst, installs);
    const again = await resolveInstall(config, spec, installs);
    return { spec, same: again.id === inst.id };
  };

  it('uses the version when it is unambiguous', async () => {
    const inst = await resolveInstall(config, '25.2');
    expect(await roundTrip(inst)).toEqual({ spec: '25.2.7.2', same: true });
  });

  it('uses the id when the version matches several installs', async () => {
    const installs = await scanLocalInstalls(config, { probe: false });
    const inst = installs.find((i) => i.root.endsWith('_copy'));
    const res = await roundTrip(inst);
    expect(res).toEqual({ spec: inst.id, same: true });
  });

  it('uses the absolute folder for an install no scan finds', async () => {
    const inst = await resolveInstall(config, external);
    const res = await roundTrip(inst);
    expect(res.spec).toBe(path.resolve(external));
    expect(res.same).toBe(true);
  });
});

const bash = (() => {
  try {
    const plan = subshellPlan('bash', tmp, { tmpDir: tmp });
    return spawnSync(plan.command, ['-c', 'true']).status === 0 ? plan.command : null;
  } catch {
    return null;
  }
})();

describe.runIf(bash)('generated bash hint for an external folder', () => {
  it('activates that folder when pasted into bash', async () => {
    const { hintsFor } = await import('../cli/commands.js');
    const inst = await resolveInstall(config, external);
    const hints = await hintsFor(inst, config, 'bash');
    expect(hints.env).not.toContain(inst.id);

    const index = path.resolve('index.js');
    const node = isWindows ? toMsysPath(process.execPath) : process.execPath;
    const script = `lovs() { "${node}" "${isWindows ? toMsysPath(index) : index}" "$@"; }\n${hints.env}\nprintf %s "\${PATH%%:*}"`;
    const res = spawnSync(bash, ['-c', script], { env: { ...process.env, TEAM: 'expanded' }, encoding: 'utf8' });
    const expected = isWindows ? toMsysPath(inst.programDir) : inst.programDir;
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe(expected);
  });
});
