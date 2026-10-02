import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { subshellPlan, toMsysPath } from '../utils/envcmd.js';
import { isWindows } from '../utils/platform.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lovs-subshell-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('subshellPlan', () => {
  it('applies the version after the start-up files for every shell', () => {
    const dir = isWindows ? 'D:\\LO\\program' : '/opt/lo/program';
    const ps = subshellPlan('powershell', dir);
    expect(ps.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']);
    const cmd = subshellPlan('cmd', dir, { windows: true, env: {} });
    expect(cmd).toMatchObject({ command: 'cmd.exe', verbatim: true });
    expect(cmd.args[0]).toBe('/K');
    expect(subshellPlan('fish', dir).args[0]).toBe('--init-command');

    const bash = subshellPlan('bash', dir, { tmpDir: tmp, env: { SHELL: '/bin/bash' } });
    const rc = Object.values(bash.files)[0];
    expect(rc.indexOf('.bashrc')).toBeLessThan(rc.indexOf('export PATH'));

    const zsh = subshellPlan('bash', '/opt/lo/program', { tmpDir: tmp, windows: false, env: { SHELL: '/usr/bin/zsh', HOME: '/home/u' } });
    expect(zsh.env.ZDOTDIR).toBe(tmp);
    const zshrc = zsh.files[path.join(tmp, '.zshrc')];
    expect(zshrc.indexOf("'/home/u'/.zshrc")).toBeLessThan(zshrc.indexOf('export PATH'));
  });
});

// Real bash (Linux, or Git Bash on Windows): a .bashrc that prepends a
// persistent default must not win over the selected version.
const plan0 = (() => {
  try {
    return subshellPlan('bash', tmp, { tmpDir: tmp });
  } catch {
    return null;
  }
})();
const bashAvailable = plan0 && spawnSync(plan0.command, ['-c', 'true']).status === 0;

describe.runIf(bashAvailable)('lovs shell with a PATH-prepending .bashrc', () => {
  it('keeps the selected version first', () => {
    const mk = (name) => {
      const dir = path.join(tmp, name, 'program');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'soffice'), `#!/bin/sh\necho ${name}\n`, { mode: 0o755 });
      return dir;
    };
    const selected = mk('selected');
    const persistentDefault = mk('default');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    const def = isWindows ? toMsysPath(persistentDefault) : persistentDefault;
    fs.writeFileSync(path.join(home, '.bashrc'), `case ":$PATH:" in *":${def}:"*) ;; *) PATH="${def}:$PATH" ;; esac\n`);

    const shellTmp = fs.mkdtempSync(path.join(tmp, 'sh-'));
    const plan = subshellPlan('bash', selected, { tmpDir: shellTmp });
    for (const [f, c] of Object.entries(plan.files)) fs.writeFileSync(f, c);
    const res = spawnSync(plan.command, [...plan.args, '-c', 'soffice'], {
      env: { ...process.env, HOME: home, ...plan.env },
      encoding: 'utf8',
    });
    expect(res.stdout.trim().split(/\r?\n/).pop()).toBe('selected');
  });
});
