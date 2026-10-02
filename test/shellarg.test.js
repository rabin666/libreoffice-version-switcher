// Generated commands must pass paths literally: no $VAR, $(...), `...` or
// %VAR% expansion, in each shell they are written for.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { activationOneLiner, quoteArg, subshellLaunchPlan } from '../utils/shell.js';
import { isWindows } from '../utils/platform.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lovs-shellarg-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const nasty = `/tmp/Office $TEAM/it's $(touch PWNED) \`touch PWNED2\` "q" \\x`;

describe('quoteArg', () => {
  it('leaves simple versions and ids alone', () => {
    for (const sh of ['bash', 'fish', 'powershell', 'cmd']) {
      expect(quoteArg(sh, '7.6.7.2')).toBe('7.6.7.2');
      expect(quoteArg(sh, 'aced11a18c')).toBe('aced11a18c');
    }
  });

  it('escapes fish single quotes and backslashes', () => {
    expect(quoteArg('fish', "a'b\\c $X")).toBe("'a\\'b\\\\c $X'");
  });

  it('refuses text cmd cannot take literally, and quotes the rest', () => {
    expect(() => quoteArg('cmd', 'C:\\100%\\x')).toThrow(/cmd/);
    expect(quoteArg('cmd', 'C:\\Program Files (x86)\\LO')).toBe('"C:\\Program Files (x86)\\LO"');
  });
});

const bash = (() => {
  try {
    const plan = subshellLaunchPlan('bash', tmp, { tmpDir: tmp });
    return spawnSync(plan.command, ['-c', 'true']).status === 0 ? plan.command : null;
  } catch {
    return null;
  }
})();

describe.runIf(bash)('in a real bash', () => {
  it('passes a path with $VAR and command substitutions literally', () => {
    const res = spawnSync(bash, ['-c', `printf %s ${quoteArg('bash', nasty)}`], {
      cwd: tmp,
      env: { ...process.env, TEAM: 'expanded' },
      encoding: 'utf8',
    });
    expect(res.stdout).toBe(nasty);
    expect(fs.existsSync(path.join(tmp, 'PWNED'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'PWNED2'))).toBe(false);
  });
});

describe.runIf(isWindows)('in real Windows shells', () => {
  it('PowerShell passes the path literally', () => {
    const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', `[Console]::Out.Write(${quoteArg('powershell', nasty)})`], {
      cwd: tmp,
      env: { ...process.env, TEAM: 'expanded' },
      encoding: 'utf8',
    });
    expect(res.stdout).toBe(nasty);
    expect(fs.existsSync(path.join(tmp, 'PWNED'))).toBe(false);
  });

  it('the cmd one-liner prepends the version and keeps the rest of PATH', () => {
    // Stand-in for `lovs env <id> --shell cmd`.
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'lovs.cmd'), '@echo set "PATH=C:\\lovs-selected\\program;%%PATH%%"\r\n');
    const input = `rem\r\n${activationOneLiner('cmd', 'aced11a18c')}\r\necho LOVSPATH=%PATH%\r\n`;
    const res = spawnSync('cmd.exe', ['/d', '/q'], { input, env: { ...process.env, PATH: `${bin};${process.env.PATH}` }, encoding: 'utf8' });
    const line = res.stdout.split(/\r?\n/).find((l) => l.includes('LOVSPATH='));
    const entries = line.slice(line.indexOf('LOVSPATH=') + 9).split(';');
    expect(entries[0]).toBe('C:\\lovs-selected\\program');
    expect(entries).toContain(bin);
    expect(line).not.toContain('%PATH%');
  });
});
